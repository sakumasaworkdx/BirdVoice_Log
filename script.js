/* eslint-disable no-console */
'use strict';

/**
 * 巨大ファイル対策の基本方針
 * - file.arrayBuffer() で全読み込みしない
 * - file.slice() で「必要な区間に相当するバイト範囲」だけBlob取得
 * - 取得Blobを <audio> でデコード/再生し、AnalyserNodeでSTFT相当の周波数スペクトルを時系列サンプリング
 *
 * 重要な注意
 * - MP3(特にVBR)は「時間→バイト変換」を平均B/sで近似するため誤差が出ます。
 *   → 解析用の切り出しBlobは多少ズレる可能性がありますが、重複(3s)で検出漏れを軽減します。
 *   → 再生は元ファイル(フル)をシークして5秒だけ再生する方式を採用し、正確な区間再生を担保します。
 */

const UI = {
  fileInput: document.getElementById('fileInput'),
  fftSize: document.getElementById('fftSize'),
  fps: document.getElementById('fps'),
  maxCards: document.getElementById('maxCards'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn'),
  barFill: document.getElementById('barFill'),
  segLabel: document.getElementById('segLabel'),
  durLabel: document.getElementById('durLabel'),
  bpsLabel: document.getElementById('bpsLabel'),
  stateLabel: document.getElementById('stateLabel'),
  log: document.getElementById('log'),
  cards: document.getElementById('cards'),
  fullAudio: document.getElementById('fullAudio'),
};

function logLine(msg) {
  const t = new Date().toLocaleTimeString();
  UI.log.textContent += `[${t}] ${msg}\n`;
  UI.log.scrollTop = UI.log.scrollHeight;
}
function setState(s) {
  UI.stateLabel.textContent = s;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function secToHMS(sec) {
  if (!Number.isFinite(sec)) return '-';
  const s = Math.max(0, sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad2 = (v) => String(v).padStart(2, '0');
  if (hh > 0) return `${hh}:${pad2(mm)}:${pad2(ss.toFixed(0))}`;
  return `${mm}:${pad2(ss.toFixed(0))}`;
}
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

/**
 * 音圧(0..255)をグレースケールに変換（見やすさ優先でガンマ）
 */
function ampToGray(a) {
  // a: 0..255
  const x = a / 255;
  // 小さい値が見えるように持ち上げ
  const g = Math.pow(x, 0.55);
  const v = Math.floor(clamp(g * 255, 0, 255));
  return v;
}

/**
 * 5秒区間のスペクトログラムをCanvasに描画
 * columns: Array<Uint8Array>（各列=周波数binの振幅0..255）
 */
function drawSpectrogram(canvas, columns) {
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const width = columns.length;
  const height = columns[0]?.length ?? 0;

  // 内部解像度はそのまま（CSSで拡大）
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);

  const img = ctx.createImageData(canvas.width, canvas.height);
  const data = img.data;

  // 下が低周波、上が高周波にしたいので縦反転描画
  for (let x = 0; x < width; x++) {
    const col = columns[x];
    for (let y = 0; y < height; y++) {
      const a = col[y]; // 0..255
      const v = ampToGray(a);
      const yy = (height - 1) - y;
      const idx = (yy * width + x) * 4;
      data[idx + 0] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);

  // 目盛りっぽい薄線（5分割）
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const xx = (canvas.width * i) / 5;
    ctx.beginPath();
    ctx.moveTo(xx, 0);
    ctx.lineTo(xx, canvas.height);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * file.slice() で「推定バイト範囲」を切り出してBlob化
 * - MP3等の圧縮音声は正確な時間切り出しが難しいため、パディングを加える。
 */
function makeSliceBlob(file, startSec, durationSec, bytesPerSec, padBytes) {
  const startByte = Math.max(0, Math.floor(startSec * bytesPerSec) - padBytes);
  const endByte = Math.min(file.size, Math.floor((startSec + durationSec) * bytesPerSec) + padBytes);
  return file.slice(startByte, endByte);
}

/**
 * <audio> をBlob URLで生成して、AnalyserNodeで周波数データを時系列取得
 * - 解析時は無音で再生（gain=0）、データ取得だけ行う
 * - 取得時間は targetSeconds（通常5秒）
 */
async function analyzeBlobSpectrogram(blob, targetSeconds, fftSize, fps, abortSignal) {
  const url = URL.createObjectURL(blob);

  // audio要素（区間Blob）
  const a = document.createElement('audio');
  a.src = url;
  a.preload = 'auto';
  a.muted = true;
  a.crossOrigin = 'anonymous';

  // canplayまで待つ（失敗時にthrow）
  await new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('この区間Blobのデコード/再生準備に失敗しました（形式やスライス境界が原因の可能性）')); };
    const cleanup = () => {
      a.removeEventListener('canplay', onOk);
      a.removeEventListener('error', onErr);
    };
    a.addEventListener('canplay', onOk, { once: true });
    a.addEventListener('error', onErr, { once: true });
    // iOS/Safari等は load() で進むことがある
    a.load();
  });

  // WebAudioセットアップ
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaElementSource(a);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;

  const gain = audioCtx.createGain();
  gain.gain.value = 0.0; // 無音解析
  src.connect(analyser);
  analyser.connect(gain);
  gain.connect(audioCtx.destination);

  const bins = analyser.frequencyBinCount;
  const hopMs = 1000 / fps;

  const columns = [];
  const tmp = new Uint8Array(bins);

  let stopRequested = false;
  const onAbort = () => { stopRequested = true; };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    // 再生開始
    // ブラウザ制約：ユーザー操作後ならOK（解析ボタンがそれ）
    await a.play();

    const startT = performance.now();
    let nextSample = startT;

    while (!stopRequested) {
      const now = performance.now();
      const elapsed = (now - startT) / 1000;
      if (elapsed >= targetSeconds) break;

      if (now >= nextSample) {
        analyser.getByteFrequencyData(tmp);
        // copy
        columns.push(new Uint8Array(tmp));
        nextSample += hopMs;
      }

      // 60Hz程度で回す
      await new Promise(r => setTimeout(r, 8));
    }

    // 念のため停止
    a.pause();

    // もし列が少なすぎる場合（デコード失敗気味）最低1列保証
    if (columns.length === 0) {
      analyser.getByteFrequencyData(tmp);
      columns.push(new Uint8Array(tmp));
    }
    return { columns, bins, fps };
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    URL.revokeObjectURL(url);
    try { a.pause(); } catch {}
    try { a.src = ''; } catch {}
    try { src.disconnect(); } catch {}
    try { analyser.disconnect(); } catch {}
    try { gain.disconnect(); } catch {}
    try { await audioCtx.close(); } catch {}
  }
}

/**
 * カードUI生成
 */
function addCard({ index, startSec, endSec, columns, fftSize, fps }) {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';

  const left = document.createElement('div');
  left.className = 'left';

  const title = document.createElement('div');
  title.className = 't';
  title.textContent = `区間 #${index}  ${secToHMS(startSec)} - ${secToHMS(endSec)}`;

  const sub = document.createElement('div');
  sub.className = 's';
  sub.textContent = `FFT=${fftSize} / FPS=${fps} / 列=${columns.length}`;

  left.appendChild(title);
  left.appendChild(sub);

  const playBtn = document.createElement('button');
  playBtn.textContent = 'この5秒を再生';
  playBtn.addEventListener('click', async () => {
    await playSegmentFromFullAudio(startSec, endSec);
  });

  head.appendChild(left);
  head.appendChild(playBtn);

  const body = document.createElement('div');
  body.className = 'card-body';

  const canvas = document.createElement('canvas');
  body.appendChild(canvas);

  card.appendChild(head);
  card.appendChild(body);

  UI.cards.appendChild(card);

  // 描画（columns[0].length = bins）
  drawSpectrogram(canvas, columns);
}

/**
 * 元ファイルをシークして、指定区間だけ再生（正確性優先）
 */
let _segTimer = null;
async function playSegmentFromFullAudio(startSec, endSec) {
  if (!UI.fullAudio.src) return;

  // 表示して操作できるようにする
  UI.fullAudio.style.display = 'block';

  // iOS/Safariでシーク直後にplayが拒否される場合があるため、少し待つ
  UI.fullAudio.currentTime = Math.max(0, startSec);
  await new Promise(r => setTimeout(r, 50));

  try { await UI.fullAudio.play(); } catch (e) { logLine(`再生開始に失敗: ${e?.message ?? e}`); return; }

  if (_segTimer) { clearTimeout(_segTimer); _segTimer = null; }

  const ms = Math.max(0, (endSec - startSec) * 1000);
  _segTimer = setTimeout(() => {
    UI.fullAudio.pause();
    _segTimer = null;
  }, ms + 30);
}

/**
 * 解析本体
 * - 5秒区間 / 3秒重複（=2秒刻み）
 * - 区間BlobごとにAnalyserでSTFTサンプリング → スペクトログラム描画
 */
let abortCtrl = null;

async function ensureFullAudioMetadata(file) {
  const url = URL.createObjectURL(file);
  // 既存URLを解放
  if (UI.fullAudio.dataset.url) {
    try { URL.revokeObjectURL(UI.fullAudio.dataset.url); } catch {}
  }
  UI.fullAudio.dataset.url = url;
  UI.fullAudio.src = url;
  UI.fullAudio.preload = 'metadata';

  const duration = await new Promise((resolve, reject) => {
    const onMeta = () => { cleanup(); resolve(UI.fullAudio.duration); };
    const onErr = () => { cleanup(); reject(new Error('音声メタデータ読み込みに失敗しました')); };
    const cleanup = () => {
      UI.fullAudio.removeEventListener('loadedmetadata', onMeta);
      UI.fullAudio.removeEventListener('error', onErr);
    };
    UI.fullAudio.addEventListener('loadedmetadata', onMeta, { once: true });
    UI.fullAudio.addEventListener('error', onErr, { once: true });
    UI.fullAudio.load();
  });

  return duration;
}

function clearUI() {
  UI.cards.innerHTML = '';
  UI.log.textContent = '';
  UI.barFill.style.width = '0%';
  UI.segLabel.textContent = '-';
  UI.durLabel.textContent = '-';
  UI.bpsLabel.textContent = '-';
  setState('待機');
}

UI.clearBtn.addEventListener('click', () => {
  clearUI();
});

UI.stopBtn.addEventListener('click', () => {
  if (abortCtrl) abortCtrl.abort();
});

UI.analyzeBtn.addEventListener('click', async () => {
  const file = UI.fileInput.files?.[0];
  if (!file) {
    alert('音声ファイルを選択してください');
    return;
  }

  const fftSize = clamp(parseInt(UI.fftSize.value, 10) || 2048, 512, 8192);
  const fps = clamp(parseInt(UI.fps.value, 10) || 60, 10, 120);
  const maxCards = clamp(parseInt(UI.maxCards.value, 10) || 300, 1, 5000);

  UI.fftSize.value = String(fftSize);
  UI.fps.value = String(fps);
  UI.maxCards.value = String(maxCards);

  // 実行制御（try/finallyで必ず復帰）
  UI.analyzeBtn.disabled = true;
  UI.stopBtn.disabled = false;

  abortCtrl = new AbortController();

  try {
    setState('メタデータ読込');
    logLine(`選択: ${file.name} (${fmtBytes(file.size)})`);

    const duration = await ensureFullAudioMetadata(file);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration取得に失敗しました');

    UI.durLabel.textContent = `${duration.toFixed(2)}s`;
    const bytesPerSec = file.size / duration;
    UI.bpsLabel.textContent = `${Math.floor(bytesPerSec).toLocaleString()} B/s`;

    // 解析パラメータ（5秒 / 3秒重複）
    const windowSec = 5.0;
    const overlapSec = 3.0;
    const stepSec = windowSec - overlapSec; // 2.0 sec

    // スライス時のパディング（境界ズレ・デコード安定化）
    // MP3等は必要に応じて増やしてください
    const padBytes = 256 * 1024; // 256KB

    const totalSegments = Math.min(maxCards, Math.ceil(Math.max(0, duration - windowSec) / stepSec) + 1);

    logLine(`duration=${duration.toFixed(2)}s / 推定B/s=${Math.floor(bytesPerSec)} / セグメント数(上限適用)=${totalSegments}`);
    logLine('解析開始…（停止ボタンで中断できます）');

    setState('解析中');

    for (let i = 0; i < totalSegments; i++) {
      if (abortCtrl.signal.aborted) throw new Error('ユーザーにより停止されました');

      const startSec = i * stepSec;
      const endSec = Math.min(duration, startSec + windowSec);

      UI.segLabel.textContent = `${i + 1}/${totalSegments} (${startSec.toFixed(2)}s)`;
      UI.barFill.style.width = `${((i) / totalSegments) * 100}%`;

      // 5秒分（＋パディング）を slice で取得
      const blob = makeSliceBlob(file, startSec, windowSec, bytesPerSec, padBytes);

      let columns;
      try {
        const res = await analyzeBlobSpectrogram(blob, windowSec, fftSize, fps, abortCtrl.signal);
        columns = res.columns;
      } catch (e) {
        // 失敗しても次へ（巨大ファイルで一部区間だけ失敗する可能性）
        logLine(`区間 #${i + 1} 解析失敗: ${e?.message ?? e}`);
        continue;
      }

      addCard({
        index: i + 1,
        startSec,
        endSec,
        columns,
        fftSize,
        fps
      });

      // UIを固めないために少し譲る
      await new Promise(r => setTimeout(r, 0));
    }

    UI.barFill.style.width = '100%';
    UI.segLabel.textContent = `完了`;
    setState('完了');
    logLine('完了');
  } catch (e) {
    setState('エラー/中断');
    logLine(`停止/エラー: ${e?.message ?? e}`);
  } finally {
    // ここで必ず復帰
    UI.analyzeBtn.disabled = false;
    UI.stopBtn.disabled = true;
    abortCtrl = null;
  }
});

// 初期表示
clearUI();
