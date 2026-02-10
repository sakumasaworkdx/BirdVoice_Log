/* eslint-disable no-console */
'use strict';

/**
 * v2 変更点（①→③ 一気）
 * ① 論文風の見た目: dBスケール(対数) + 白背景/黒インク + コントラスト調整
 * ② 鳥向け帯域カット: minHz〜maxHz を表示
 * ③ PNG一括書き出し: 外部ライブラリなしのZIP生成（STORE=無圧縮）
 *
 * 巨大ファイル対策
 * - file.arrayBuffer() 全読み込み禁止
 * - file.slice() で必要区間Blobだけを順次解析
 *
 * 注意
 * - MP3(VBR) は「時間→バイト」が近似なので解析区間が多少ズレます（3秒重複で軽減）
 * - 再生は正確性優先で「元ファイルをシークしてその5秒だけ再生」
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
function setState(s) {
  UI.stateLabel.textContent = s;
}
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

/**
 * dB風スケールにして白背景に黒で描画する
 * - input: columns: Array<Uint8Array> (0..255)
 * - band crop: yStart..yEnd
 */
function drawSpectrogram(canvas, columns, opts) {
  const { yStart, yEnd, minDb, maxDb } = opts;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const width = columns.length;
  const fullBins = columns[0]?.length ?? 0;
  const ys = clamp(yStart, 0, Math.max(0, fullBins-1));
  const ye = clamp(yEnd, ys+1, fullBins);
  const height = Math.max(1, ye - ys);

  canvas.width = Math.max(1, width);
  canvas.height = height;

  // 白背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,canvas.width,canvas.height);

  const img = ctx.createImageData(canvas.width, canvas.height);
  const data = img.data;

  // dB変換: byte(0..255)->amp(0..1)->db(負)  ※+1e-6で-∞回避
  // 正規化: [minDb..maxDb] を [0..1] へ
  const invRange = 1.0 / Math.max(1e-6, (maxDb - minDb));

  for (let x=0; x<width; x++){
    const col = columns[x];
    for (let yy=0; yy<height; yy++){
      const y = ys + yy;
      const byte = col[y];
      const amp = byte / 255;
      const db = 20 * Math.log10(amp + 1e-6); // だいたい -120..0
      const norm = clamp((db - minDb) * invRange, 0, 1); // 0..1
      // 白背景: 音が強いほど黒く
      const ink = 255 - Math.floor(norm * 255);
      // 上が高周波にしたいので縦反転
      const yFlip = (height - 1) - yy;
      const idx = (yFlip * width + x) * 4;
      data[idx+0] = ink;
      data[idx+1] = ink;
      data[idx+2] = ink;
      data[idx+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 薄いガイド線（時間方向 5分割）
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  for (let i=1;i<5;i++){
    const xx = (canvas.width*i)/5;
    ctx.beginPath();
    ctx.moveTo(xx,0);
    ctx.lineTo(xx,canvas.height);
    ctx.stroke();
  }
  ctx.restore();
}

function makeSliceBlob(file, startSec, durationSec, bytesPerSec, padBytes) {
  const startByte = Math.max(0, Math.floor(startSec * bytesPerSec) - padBytes);
  const endByte = Math.min(file.size, Math.floor((startSec + durationSec) * bytesPerSec) + padBytes);
  return file.slice(startByte, endByte);
}

/**
 * Blob URL → <audio> 再生しながら Analyser で周波数データを時系列取得（STFT相当）
 * - 解析中は無音(gain=0)
 */
async function analyzeBlobSpectrogram(blob, targetSeconds, fftSize, fps, abortSignal) {
  const url = URL.createObjectURL(blob);

  const a = document.createElement('audio');
  a.src = url;
  a.preload = 'auto';
  a.muted = true;
  a.crossOrigin = 'anonymous';

  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const ng = () => { cleanup(); reject(new Error('この区間Blobのデコード/準備に失敗（形式/スライス境界の可能性）')); };
    const cleanup = () => {
      a.removeEventListener('canplay', ok);
      a.removeEventListener('error', ng);
    };
    a.addEventListener('canplay', ok, { once:true });
    a.addEventListener('error', ng, { once:true });
    a.load();
  });

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaElementSource(a);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;

  const gain = audioCtx.createGain();
  gain.gain.value = 0.0;

  src.connect(analyser);
  analyser.connect(gain);
  gain.connect(audioCtx.destination);

  const bins = analyser.frequencyBinCount;
  const tmp = new Uint8Array(bins);
  const hopMs = 1000 / fps;

  const columns = [];

  let stopRequested = false;
  const onAbort = () => { stopRequested = true; };
  abortSignal?.addEventListener('abort', onAbort, { once:true });

  try{
    await a.play();

    const startT = performance.now();
    let nextSample = startT;

    while (!stopRequested){
      const now = performance.now();
      const elapsed = (now - startT) / 1000;
      if (elapsed >= targetSeconds) break;

      if (now >= nextSample){
        analyser.getByteFrequencyData(tmp);
        columns.push(new Uint8Array(tmp));
        nextSample += hopMs;
      }
      await new Promise(r => setTimeout(r, 8));
    }

    a.pause();
    if (columns.length === 0){
      analyser.getByteFrequencyData(tmp);
      columns.push(new Uint8Array(tmp));
    }

    return { columns, sampleRate: audioCtx.sampleRate, fftSize, fps };
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

let _segTimer = null;
async function playSegmentFromFullAudio(startSec, endSec) {
  if (!UI.fullAudio.src) return;
  UI.fullAudio.style.display = 'block';

  UI.fullAudio.currentTime = Math.max(0, startSec);
  await new Promise(r => setTimeout(r, 50));

  try { await UI.fullAudio.play(); }
  catch(e){ logLine(`再生開始に失敗: ${e?.message ?? e}`); return; }

  if (_segTimer){ clearTimeout(_segTimer); _segTimer = null; }
  const ms = Math.max(0, (endSec - startSec) * 1000);
  _segTimer = setTimeout(() => {
    UI.fullAudio.pause();
    _segTimer = null;
  }, ms + 30);
}

/**
 * カード作成
 * - canvasに描画
 * - canvas参照を dataset に保持（ZIP書き出し用）
 */
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

  // 帯域bin算出
  const binHz = sampleRate / fftSize;
  const yStart = Math.floor(band.minHz / binHz);
  const yEnd = Math.floor(band.maxHz / binHz);

  drawSpectrogram(canvas, columns, {
    yStart, yEnd,
    minDb: dbRange.minDb,
    maxDb: dbRange.maxDb
  });

  // ZIP用メタ
  canvas.dataset.segIndex = String(index);
  canvas.dataset.startSec = String(startSec);
  canvas.dataset.endSec = String(endSec);
}

/** ========= ZIP (外部ライブラリ無し / STORE) ========= */

/**
 * CRC32
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i=0;i<256;i++){
    let c=i;
    for (let k=0;k<8;k++){
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i]=c>>>0;
  }
  return table;
})();
function crc32(u8){
  let c = 0xFFFFFFFF;
  for (let i=0;i<u8.length;i++){
    c = CRC32_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(v){
  const a = new Uint8Array(2);
  new DataView(a.buffer).setUint16(0, v, true);
  return a;
}
function u32(v){
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, v, true);
  return a;
}
function strU8(s){
  return new TextEncoder().encode(s);
}

/**
 * ZIP生成（STORE=圧縮なし）
 * files: [{name: string, data: Uint8Array}]
 */
function buildZip(files){
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files){
    const nameU8 = strU8(f.name);
    const dataU8 = f.data;
    const crc = crc32(dataU8);

    // local file header
    // 0x04034b50
    const local = [
      u32(0x04034b50),
      u16(20),         // version needed
      u16(0),          // flags
      u16(0),          // compression 0=STORE
      u16(0), u16(0),  // time/date (0)
      u32(crc),
      u32(dataU8.length),
      u32(dataU8.length),
      u16(nameU8.length),
      u16(0),          // extra len
      nameU8
    ];
    for (const p of local){ parts.push(p); offset += p.length; }

    // file data
    parts.push(dataU8); offset += dataU8.length;

    // central directory header
    const cdOffset = offset - (dataU8.length + local.reduce((s,p)=>s+p.length,0));
    const centralHdr = [
      u32(0x02014b50),
      u16(20),         // version made by
      u16(20),         // version needed
      u16(0),          // flags
      u16(0),          // compression
      u16(0), u16(0),  // time/date
      u32(crc),
      u32(dataU8.length),
      u32(dataU8.length),
      u16(nameU8.length),
      u16(0),          // extra
      u16(0),          // comment
      u16(0),          // disk number
      u16(0),          // internal attr
      u32(0),          // external attr
      u32(cdOffset),
      nameU8
    ];
    central.push(...centralHdr);
  }

  const centralStart = offset;
  for (const p of central){ parts.push(p); offset += p.length; }
  const centralSize = offset - centralStart;

  // end of central directory
  const eocd = [
    u32(0x06054b50),
    u16(0), u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(centralStart),
    u16(0)
  ];
  for (const p of eocd){ parts.push(p); offset += p.length; }

  return new Blob(parts, { type: 'application/zip' });
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function canvasesToZip(){
  const canvases = Array.from(UI.cards.querySelectorAll('canvas'));
  if (canvases.length === 0){
    alert('カードがありません');
    return;
  }
  setState('ZIP作成中');
  UI.exportZipBtn.disabled = true;

  try{
    logLine(`PNG出力開始: ${canvases.length}枚`);

    const files = [];
    for (let i=0;i<canvases.length;i++){
      const c = canvases[i];
      const idx = zpad(i+1, 4);
      const seg = zpad(parseInt(c.dataset.segIndex||'0',10), 4);
      const name = `${idx}_seg${seg}.png`;

      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
      if (!blob){ logLine(`toBlob失敗: ${name}`); continue; }
      const buf = await blob.arrayBuffer();
      files.push({ name, data: new Uint8Array(buf) });

      if ((i+1) % 25 === 0) logLine(`PNG化 ${i+1}/${canvases.length}`);
      await new Promise(r => setTimeout(r, 0));
    }

    const zip = buildZip(files);
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    downloadBlob(zip, `spectrogram_${stamp}.zip`);
    logLine('ZIP完了');
    setState('完了');
  } catch(e){
    logLine(`ZIP失敗: ${e?.message ?? e}`);
    setState('エラー');
  } finally {
    UI.exportZipBtn.disabled = false;
  }
}

/** ========= 実行制御 ========= */
let abortCtrl = null;

async function ensureFullAudioMetadata(file){
  const url = URL.createObjectURL(file);
  if (UI.fullAudio.dataset.url){
    try { URL.revokeObjectURL(UI.fullAudio.dataset.url); } catch {}
  }
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
    UI.fullAudio.addEventListener('loadedmetadata', ok, { once:true });
    UI.fullAudio.addEventListener('error', ng, { once:true });
    UI.fullAudio.load();
  });
  return duration;
}

function clearUI(){
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
  if (!file){ alert('音声ファイルを選択してください'); return; }

  const fftSize = clamp(parseInt(UI.fftSize.value,10) || 1024, 512, 8192);
  const fps = clamp(parseInt(UI.fps.value,10) || 60, 10, 120);
  const minHz = clamp(parseInt(UI.minHz.value,10) || 2000, 0, 24000);
  const maxHz = clamp(parseInt(UI.maxHz.value,10) || 10000, 0, 24000);
  const minDb = clamp(parseInt(UI.minDb.value,10) || -80, -120, -10);
  const maxDb = clamp(parseInt(UI.maxDb.value,10) || 0, -120, 0);
  const maxCards = clamp(parseInt(UI.maxCards.value,10) || 300, 1, 5000);

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

  try{
    setState('メタデータ読込');
    logLine(`選択: ${file.name} (${fmtBytes(file.size)})`);

    const duration = await ensureFullAudioMetadata(file);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration取得に失敗');

    UI.durLabel.textContent = `${duration.toFixed(2)}s`;
    const bytesPerSec = file.size / duration;
    UI.bpsLabel.textContent = `${Math.floor(bytesPerSec).toLocaleString()} B/s`;

    const windowSec = 5.0;
    const overlapSec = 3.0;
    const stepSec = windowSec - overlapSec; // 2s
    const padBytes = 256 * 1024; // 256KB

    const totalSegments = Math.min(maxCards, Math.ceil(Math.max(0, duration - windowSec) / stepSec) + 1);

    logLine(`duration=${duration.toFixed(2)}s / 推定B/s=${Math.floor(bytesPerSec)} / セグメント上限=${totalSegments}`);
    logLine('解析開始…');

    setState('解析中');

    for (let i=0;i<totalSegments;i++){
      if (abortCtrl.signal.aborted) throw new Error('ユーザーにより停止');

      const startSec = i * stepSec;
      const endSec = Math.min(duration, startSec + windowSec);

      UI.segLabel.textContent = `${i+1}/${totalSegments} (${startSec.toFixed(2)}s)`;
      UI.barFill.style.width = `${(i/totalSegments)*100}%`;

      const blob = makeSliceBlob(file, startSec, windowSec, bytesPerSec, padBytes);

      try{
        const res = await analyzeBlobSpectrogram(blob, windowSec, fftSize, fps, abortCtrl.signal);

        addCard({
          index: i+1,
          startSec,
          endSec,
          columns: res.columns,
          sampleRate: res.sampleRate,
          fftSize,
          fps,
          band: { minHz: Math.min(minHz, maxHz), maxHz: Math.max(minHz, maxHz) },
          dbRange: { minDb: Math.min(minDb, maxDb), maxDb: Math.max(minDb, maxDb) }
        });

        UI.exportZipBtn.disabled = false;
      } catch(e){
        logLine(`区間 #${i+1} 解析失敗: ${e?.message ?? e}`);
        continue;
      }

      await new Promise(r => setTimeout(r, 0));
    }

    UI.barFill.style.width = '100%';
    UI.segLabel.textContent = '完了';
    setState('完了');
    logLine('完了');
  } catch(e){
    setState('エラー/中断');
    logLine(`停止/エラー: ${e?.message ?? e}`);
  } finally {
    UI.analyzeBtn.disabled = false;
    UI.stopBtn.disabled = true;
    abortCtrl = null;
  }
});

clearUI();
