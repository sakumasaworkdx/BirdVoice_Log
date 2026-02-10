/* eslint-disable no-console */
'use strict';

/**
 * v4 重要修正（白紙問題の原因）
 * - <audio>.muted = true にすると、MediaElementSource への入力も「無音」扱いになりやすく、
 *   analyser が常に最小dB(=白)になっていました。
 * - 対策: muted を使わず、audio.volume=1.0 のまま WebAudio 側の Gain(0) で無音化。
 *
 * 解析方式（安定優先）
 * - 全形式で「元ファイルをシークして5秒だけ無音解析」を使用
 *   （巨大ファイルでもブラウザは全読み込みせず、メモリ一定）
 * - これで MP3(VBR) の sliceズレ / WAVヘッダ問題 を避けます。
 *
 * PNG一括(ZIP): 外部ライブラリなし（ZIP STORE）
 */

const UI = {
  fileInput: document.getElementById('fileInput'),
  fftSize: document.getElementById('fftSize'),
  fps: document.getElementById('fps'),
  minHz: document.getElementById('minHz'),
  maxHz: document.getElementById('maxHz'),
  minDb: document.getElementById('minDb'),
  maxDb: document.getElementById('maxDb'),
  maxCards: document.getElementById('maxCards'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  stopBtn: document.getElementById('stopBtn'),
  exportZipBtn: document.getElementById('exportZipBtn'),
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
function setState(s) { UI.stateLabel.textContent = s; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
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
  const u = ['B','KB','MB','GB','TB'];
  let x=n, i=0;
  while (x>=1024 && i<u.length-1){ x/=1024; i++; }
  return `${x.toFixed(i===0?0:2)} ${u[i]}`;
}
function zpad(num, len){ return String(num).padStart(len,'0'); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/** ========= スペクトログラム描画（dB） ========= */
/**
 * columns: Array<Float32Array> (dB)
 */
function drawSpectrogram(canvas, columns, opts) {
  const { yStart, yEnd, minDb, maxDb } = opts;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const width = columns.length;
  const fullBins = columns[0]?.length ?? 0;

  const ys = clamp(yStart, 0, Math.max(0, fullBins - 1));
  const ye = clamp(yEnd, ys + 1, fullBins);
  const height = Math.max(1, ye - ys);

  canvas.width = Math.max(1, width);
  canvas.height = height;

  // 白背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const img = ctx.createImageData(canvas.width, canvas.height);
  const data = img.data;

  const invRange = 1.0 / Math.max(1e-6, (maxDb - minDb));

  for (let x = 0; x < width; x++) {
    const col = columns[x];
    for (let yy = 0; yy < height; yy++) {
      const y = ys + yy;
      const db = col[y];
      const norm = clamp((db - minDb) * invRange, 0, 1);
      const ink = 255 - Math.floor(norm * 255);
      const yFlip = (height - 1) - yy;
      const idx = (yFlip * width + x) * 4;
      data[idx + 0] = ink;
      data[idx + 1] = ink;
      data[idx + 2] = ink;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);

  // ガイド線（時間方向）
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = '#000000';
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

/** ========= 解析用アナライザ（シーク方式） ========= */
let analyzer = {
  url: null,
  audio: null,
  audioCtx: null,
  src: null,
  analyser: null,
  gain: null,
  inited: false,
};

async function initAnalyzerForFile(file) {
  // URL更新
  if (analyzer.url) { try { URL.revokeObjectURL(analyzer.url); } catch {} }
  analyzer.url = URL.createObjectURL(file);

  // audio element
  if (!analyzer.audio) analyzer.audio = document.createElement('audio');
  analyzer.audio.src = analyzer.url;
  analyzer.audio.preload = 'auto';
  analyzer.audio.volume = 1.0; // ★ muted禁止（これが白紙の主因）
  analyzer.audio.muted = false;

  // canplay待ち
  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const ng = () => { cleanup(); reject(new Error('解析用audioの準備に失敗')); };
    const cleanup = () => {
      analyzer.audio.removeEventListener('canplay', ok);
      analyzer.audio.removeEventListener('error', ng);
    };
    analyzer.audio.addEventListener('canplay', ok, { once: true });
    analyzer.audio.addEventListener('error', ng, { once: true });
    analyzer.audio.load();
  });

  // WebAudio graph（初回のみ作成）
  if (!analyzer.audioCtx) {
    analyzer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyzer.src = analyzer.audioCtx.createMediaElementSource(analyzer.audio);
    analyzer.analyser = analyzer.audioCtx.createAnalyser();
    analyzer.gain = analyzer.audioCtx.createGain();
    analyzer.gain.gain.value = 0.0; // ★ ここで無音化
    analyzer.src.connect(analyzer.analyser);
    analyzer.analyser.connect(analyzer.gain);
    analyzer.gain.connect(analyzer.audioCtx.destination);
  }

  analyzer.inited = true;
}

async function analyzeBySeeking(startSec, targetSeconds, fftSize, fps, dbRange, abortSignal) {
  if (!analyzer.inited) throw new Error('analyzer未初期化');

  analyzer.analyser.fftSize = fftSize;
  analyzer.analyser.smoothingTimeConstant = 0;
  analyzer.analyser.minDecibels = dbRange.minDb;
  analyzer.analyser.maxDecibels = dbRange.maxDb;

  const bins = analyzer.analyser.frequencyBinCount;
  const tmp = new Float32Array(bins);
  const hopMs = 1000 / fps;
  const columns = [];

  let stopRequested = false;
  const onAbort = () => { stopRequested = true; };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    analyzer.audio.currentTime = Math.max(0, startSec);
    await sleep(80); // シーク反映待ち

    await analyzer.audio.play();

    const startT = performance.now();
    let nextSample = startT;

    while (!stopRequested) {
      const now = performance.now();
      const elapsed = (now - startT) / 1000;
      if (elapsed >= targetSeconds) break;

      if (now >= nextSample) {
        analyzer.analyser.getFloatFrequencyData(tmp);
        columns.push(new Float32Array(tmp));
        nextSample += hopMs;
      }
      await sleep(8);
    }

    analyzer.audio.pause();

    if (columns.length === 0) {
      analyzer.analyser.getFloatFrequencyData(tmp);
      columns.push(new Float32Array(tmp));
    }

    return { columns, sampleRate: analyzer.audioCtx.sampleRate, fftSize, fps };
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    try { analyzer.audio.pause(); } catch {}
  }
}

/** ========= 再生（元ファイルをシークして5秒だけ） ========= */
let _segTimer = null;
async function playSegmentFromFullAudio(startSec, endSec) {
  if (!UI.fullAudio.src) return;
  UI.fullAudio.style.display = 'block';

  UI.fullAudio.currentTime = Math.max(0, startSec);
  await sleep(50);

  try { await UI.fullAudio.play(); }
  catch (e) { logLine(`再生開始に失敗: ${e?.message ?? e}`); return; }

  if (_segTimer) { clearTimeout(_segTimer); _segTimer = null; }
  const ms = Math.max(0, (endSec - startSec) * 1000);
  _segTimer = setTimeout(() => {
    UI.fullAudio.pause();
    _segTimer = null;
  }, ms + 30);
}

/** ========= カードUI ========= */
function addCard({ index, startSec, endSec, columns, sampleRate, fftSize, fps, band, dbRange }) {
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
  sub.textContent = `FFT=${fftSize} / FPS=${fps} / 帯域=${band.minHz}-${band.maxHz}Hz / dB=${dbRange.minDb}..${dbRange.maxDb} / 列=${columns.length}`;

  left.appendChild(title);
  left.appendChild(sub);

  const playBtn = document.createElement('button');
  playBtn.textContent = 'この5秒を再生';
  playBtn.addEventListener('click', async () => { await playSegmentFromFullAudio(startSec, endSec); });

  head.appendChild(left);
  head.appendChild(playBtn);

  const body = document.createElement('div');
  body.className = 'card-body';

  const canvas = document.createElement('canvas');
  body.appendChild(canvas);

  card.appendChild(head);
  card.appendChild(body);
  UI.cards.appendChild(card);

  const binHz = sampleRate / fftSize;
  const yStart = Math.floor(band.minHz / binHz);
  const yEnd = Math.floor(band.maxHz / binHz);

  drawSpectrogram(canvas, columns, { yStart, yEnd, minDb: dbRange.minDb, maxDb: dbRange.maxDb });

  canvas.dataset.segIndex = String(index);
  UI.exportZipBtn.disabled = false;
}

/** ========= ZIP（STORE） ========= */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC32_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function u16(v) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v, true); return a; }
function u32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v, true); return a; }
function strU8(s) { return new TextEncoder().encode(s); }

function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameU8 = strU8(f.name);
    const dataU8 = f.data;
    const crc = crc32(dataU8);

    const local = [
      u32(0x04034b50),
      u16(20), u16(0), u16(0),
      u16(0), u16(0),
      u32(crc),
      u32(dataU8.length),
      u32(dataU8.length),
      u16(nameU8.length),
      u16(0),
      nameU8
    ];
    for (const p of local) { parts.push(p); offset += p.length; }
    parts.push(dataU8); offset += dataU8.length;

    const cdOffset = offset - (dataU8.length + local.reduce((s, p) => s + p.length, 0));
    const centralHdr = [
      u32(0x02014b50),
      u16(20), u16(20),
      u16(0), u16(0),
      u16(0), u16(0),
      u32(crc),
      u32(dataU8.length),
      u32(dataU8.length),
      u16(nameU8.length),
      u16(0), u16(0),
      u16(0), u16(0),
      u32(0),
      u32(cdOffset),
      nameU8
    ];
    central.push(...centralHdr);
  }

  const centralStart = offset;
  for (const p of central) { parts.push(p); offset += p.length; }
  const centralSize = offset - centralStart;

  const eocd = [
    u32(0x06054b50),
    u16(0), u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(centralStart),
    u16(0)
  ];
  for (const p of eocd) { parts.push(p); offset += p.length; }

  return new Blob(parts, { type: 'application/zip' });
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function canvasesToZip() {
  const canvases = Array.from(UI.cards.querySelectorAll('canvas'));
  if (canvases.length === 0) { alert('カードがありません'); return; }

  setState('ZIP作成中');
  UI.exportZipBtn.disabled = true;

  try {
    logLine(`PNG出力開始: ${canvases.length}枚`);
    const files = [];

    for (let i = 0; i < canvases.length; i++) {
      const c = canvases[i];
      const idx = zpad(i + 1, 4);
      const seg = zpad(parseInt(c.dataset.segIndex || '0', 10), 4);
      const name = `${idx}_seg${seg}.png`;

      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
      if (!blob) { logLine(`toBlob失敗: ${name}`); continue; }
      const buf = await blob.arrayBuffer();
      files.push({ name, data: new Uint8Array(buf) });

      if ((i + 1) % 25 === 0) logLine(`PNG化 ${i + 1}/${canvases.length}`);
      await sleep(0);
    }

    const zip = buildZip(files);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(zip, `spectrogram_${stamp}.zip`);
    logLine('ZIP完了');
    setState('完了');
  } catch (e) {
    logLine(`ZIP失敗: ${e?.message ?? e}`);
    setState('エラー');
  } finally {
    UI.exportZipBtn.disabled = false;
  }
}

/** ========= 実行制御 ========= */
let abortCtrl = null;

async function ensureFullAudioMetadata(file) {
  const url = URL.createObjectURL(file);
  if (UI.fullAudio.dataset.url) { try { URL.revokeObjectURL(UI.fullAudio.dataset.url); } catch {} }
  UI.fullAudio.dataset.url = url;
  UI.fullAudio.src = url;
  UI.fullAudio.preload = 'metadata';

  const duration = await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(UI.fullAudio.duration); };
    const ng = () => { cleanup(); reject(new Error('音声メタデータ読み込みに失敗')); };
    const cleanup = () => {
      UI.fullAudio.removeEventListener('loadedmetadata', ok);
      UI.fullAudio.removeEventListener('error', ng);
    };
    UI.fullAudio.addEventListener('loadedmetadata', ok, { once: true });
    UI.fullAudio.addEventListener('error', ng, { once: true });
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
  UI.fullAudio.style.display = 'none';
  UI.exportZipBtn.disabled = true;
  setState('待機');
}

UI.clearBtn.addEventListener('click', clearUI);
UI.stopBtn.addEventListener('click', () => { if (abortCtrl) abortCtrl.abort(); });
UI.exportZipBtn.addEventListener('click', async () => { await canvasesToZip(); });

UI.analyzeBtn.addEventListener('click', async () => {
  const file = UI.fileInput.files?.[0];
  if (!file) { alert('音声ファイルを選択してください'); return; }

  const fftSize = clamp(parseInt(UI.fftSize.value, 10) || 1024, 512, 8192);
  const fps = clamp(parseInt(UI.fps.value, 10) || 60, 10, 120);
  const minHz = clamp(parseInt(UI.minHz.value, 10) || 2000, 0, 24000);
  const maxHz = clamp(parseInt(UI.maxHz.value, 10) || 10000, 0, 24000);
  const minDb = clamp(parseInt(UI.minDb.value, 10) || -80, -120, -10);
  const maxDb = clamp(parseInt(UI.maxDb.value, 10) || 0, -120, 0);
  const maxCards = clamp(parseInt(UI.maxCards.value, 10) || 300, 1, 5000);

  UI.fftSize.value = String(fftSize);
  UI.fps.value = String(fps);
  UI.minHz.value = String(Math.min(minHz, maxHz));
  UI.maxHz.value = String(Math.max(minHz, maxHz));
  UI.minDb.value = String(Math.min(minDb, maxDb));
  UI.maxDb.value = String(Math.max(minDb, maxDb));
  UI.maxCards.value = String(maxCards);

  UI.analyzeBtn.disabled = true;
  UI.stopBtn.disabled = false;
  UI.exportZipBtn.disabled = true;
  abortCtrl = new AbortController();

  try {
    setState('メタデータ読込');
    logLine(`選択: ${file.name} (${fmtBytes(file.size)})`);

    const duration = await ensureFullAudioMetadata(file);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration取得に失敗');

    UI.durLabel.textContent = `${duration.toFixed(2)}s`;
    const bytesPerSec = file.size / duration;
    UI.bpsLabel.textContent = `${Math.floor(bytesPerSec).toLocaleString()} B/s`;

    // 解析用アナライザ初期化（ここが本体）
    logLine('解析方式: シーク（全形式）');
    await initAnalyzerForFile(file);

    const windowSec = 5.0;
    const overlapSec = 3.0;
    const stepSec = windowSec - overlapSec; // 2s

    const totalSegments = Math.min(maxCards, Math.ceil(Math.max(0, duration - windowSec) / stepSec) + 1);
    logLine(`duration=${duration.toFixed(2)}s / セグメント上限=${totalSegments}`);
    logLine('解析開始…');
    setState('解析中');

    const band = { minHz: Math.min(minHz, maxHz), maxHz: Math.max(minHz, maxHz) };
    const dbRange = { minDb: Math.min(minDb, maxDb), maxDb: Math.max(minDb, maxDb) };

    for (let i = 0; i < totalSegments; i++) {
      if (abortCtrl.signal.aborted) throw new Error('ユーザーにより停止');

      const startSec = i * stepSec;
      const endSec = Math.min(duration, startSec + windowSec);

      UI.segLabel.textContent = `${i + 1}/${totalSegments} (${startSec.toFixed(2)}s)`;
      UI.barFill.style.width = `${(i / totalSegments) * 100}%`;

      try {
        const res = await analyzeBySeeking(startSec, windowSec, fftSize, fps, dbRange, abortCtrl.signal);
        addCard({
          index: i + 1,
          startSec, endSec,
          columns: res.columns,
          sampleRate: res.sampleRate,
          fftSize, fps,
          band, dbRange
        });
      } catch (e) {
        logLine(`区間 #${i + 1} 解析失敗: ${e?.message ?? e}`);
        continue;
      }

      await sleep(0);
    }

    UI.barFill.style.width = '100%';
    UI.segLabel.textContent = '完了';
    setState('完了');
    logLine('完了');
  } catch (e) {
    setState('エラー/中断');
    logLine(`停止/エラー: ${e?.message ?? e}`);
  } finally {
    UI.analyzeBtn.disabled = false;
    UI.stopBtn.disabled = true;
    abortCtrl = null;
  }
});

clearUI();
