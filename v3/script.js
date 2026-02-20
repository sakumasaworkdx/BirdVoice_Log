/* eslint-disable no-console */
'use strict';

/**
 * v2.2（重要）
 * - v2で止まる原因: タイル生成ごとに audio.play() すると、Chromeの自動再生制限で失敗 → 解析が進まない
 * - 対策: 「解析用audio」を prepare(ユーザー操作)で一度だけ play() し、その後は常時再生状態のまま seek してサンプリング
 *
 * 追加機能（v2要件）
 * - 色マップ（Turbo/Magma/Viridis/Gray）
 * - 対数周波数軸（log / linear）
 * - 鳥声帯域の強調表示（帯域ハイライト）
 * - PNG書き出し（表示中ビューポート）
 */

const UI = {
  fileInput: document.getElementById('fileInput'),
  fftSize: document.getElementById('fftSize'),
  fps: document.getElementById('fps'),
  minHz: document.getElementById('minHz'),
  maxHz: document.getElementById('maxHz'),
  minDb: document.getElementById('minDb'),
  maxDb: document.getElementById('maxDb'),
  pxPerSec: document.getElementById('pxPerSec'),
  tileSec: document.getElementById('tileSec'),
  cacheTiles: document.getElementById('cacheTiles'),
  colorMap: document.getElementById('colorMap'),
  freqScale: document.getElementById('freqScale'),
  bandHighlight: document.getElementById('bandHighlight'),
  birdMinHz: document.getElementById('birdMinHz'),
  birdMaxHz: document.getElementById('birdMaxHz'),

  prepareBtn: document.getElementById('prepareBtn'),
  playBtn: document.getElementById('playBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  exportViewBtn: document.getElementById('exportViewBtn'),
  clearBtn: document.getElementById('clearBtn'),

  barFill: document.getElementById('barFill'),
  durLabel: document.getElementById('durLabel'),
  stateLabel: document.getElementById('stateLabel'),
  viewLabel: document.getElementById('viewLabel'),
  tileLabel: document.getElementById('tileLabel'),
  log: document.getElementById('log'),

  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  specCanvas: document.getElementById('specCanvas'),

  fullAudio: document.getElementById('fullAudio'),

  scanMinHz: document.getElementById('scanMinHz'),
  scanThresholdDb: document.getElementById('scanThresholdDb'),
  scanStepSec: document.getElementById('scanStepSec'),
  presetSmallBird: document.getElementById('presetSmallBird'),
  presetRaptor: document.getElementById('presetRaptor'),
  presetAll: document.getElementById('presetAll'),
  scanBtn: document.getElementById('scanBtn'),
  scanStopBtn: document.getElementById('scanStopBtn'),
  detectList: document.getElementById('detectList'),
  detectCount: document.getElementById('detectCount'),
  scanBarFill: document.getElementById('scanBarFill'),
  scanStatus: document.getElementById('scanStatus'),
};

function logLine(msg) {
  const t = new Date().toLocaleTimeString();
  UI.log.textContent += `[${t}] ${msg}\n`;
  UI.log.scrollTop = UI.log.scrollHeight;
}
function setState(s) { UI.stateLabel.textContent = s; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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
function nowMs(){ return performance.now(); }

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

/** ===================== Color maps ===================== */
function turbo(t){
  t = clamp(t,0,1);
  const r = clamp(34.61 + t*(1172.33 + t*(-10793.56 + t*(33300.12 + t*(-38394.49 + t*14825.05)))), 0, 255);
  const g = clamp(23.31 + t*(557.33 + t*(1225.33 + t*(-3574.96 + t*(1858.50 + t*0.00)))), 0, 255);
  const b = clamp(27.20 + t*(3211.10 + t*(-15327.97 + t*(27814.00 + t*(-22569.18 + t*6838.66)))), 0, 255);
  return [r|0, g|0, b|0];
}
function viridis(t){
  t = clamp(t,0,1);
  const stops = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37]
  ];
  const x = t * (stops.length-1);
  const i = Math.min(stops.length-2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i+1];
  return [
    (a[0] + (b[0]-a[0])*f)|0,
    (a[1] + (b[1]-a[1])*f)|0,
    (a[2] + (b[2]-a[2])*f)|0,
  ];
}
function magma(t){
  t = clamp(t,0,1);
  const stops = [
    [0,0,4],
    [78,18,123],
    [150,54,143],
    [219,118,89],
    [251,252,191]
  ];
  const x = t * (stops.length-1);
  const i = Math.min(stops.length-2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i+1];
  return [
    (a[0] + (b[0]-a[0])*f)|0,
    (a[1] + (b[1]-a[1])*f)|0,
    (a[2] + (b[2]-a[2])*f)|0,
  ];
}
function grayscale(t){
  const v = (255 - Math.floor(clamp(t,0,1)*255))|0;
  return [v,v,v];
}

function buildFeatureBands(cfg){
  const minHz = Math.max(1, cfg.minHz);
  const maxHz = Math.max(minHz + 1, cfg.maxHz);
  const edges = new Float32Array(FEATURE_BANDS + 1);
  const a = Math.log(minHz);
  const b = Math.log(maxHz);
  for (let i=0;i<=FEATURE_BANDS;i++){
    const t = i / FEATURE_BANDS;
    edges[i] = Math.exp(a + (b-a)*t);
  }
  return edges;
}

function spectrumToFeatureBands(tmpDb, cfg, edges){
  // tmpDb is Float32Array of dB per bin
  const sr = analyzer.audioCtx.sampleRate;
  const binHz = sr / cfg.fftSize;
  const bins = tmpDb.length;
  const out = new Uint16Array(FEATURE_BANDS);
  // store mean dB in each band as uint16 (db*100 + 12000)
  for (let bi=0; bi<FEATURE_BANDS; bi++){
    const loHz = edges[bi];
    const hiHz = edges[bi+1];
    const lo = clamp(Math.floor(loHz / binHz), 0, bins-1);
    const hi = clamp(Math.ceil(hiHz / binHz), 0, bins-1);
    if (hi <= lo){
      out[bi] = 0;
      continue;
    }
    let sumP = 0;
    let n = 0;
    for (let i=lo;i<=hi;i++){
      const db = tmpDb[i];
      const p = Math.pow(10, (Math.max(-120, db) / 10));
      sumP += p; n++;
    }
    const meanP = sumP / Math.max(1, n);
    const meanDb = 10 * Math.log10(Math.max(1e-12, meanP));
    const q = clamp(Math.round((meanDb * 100) + 12000), 0, 65535);
    out[bi] = q;
  }
  return out;
}

function featureBandsToMeanDb(featureBands, cfg, edges, minHz, maxHz){
  // sum selected bands in linear power, then mean
  // decode band mean dB -> power, sum, average
  let sumP = 0;
  let n = 0;
  for (let bi=0; bi<FEATURE_BANDS; bi++){
    const loHz = edges[bi];
    const hiHz = edges[bi+1];
    if (hiHz <= minHz || loHz >= maxHz) continue;
    const db = (featureBands[bi] - 12000) / 100;
    const p = Math.pow(10, (db / 10));
    sumP += p; n++;
  }
  if (n <= 0) return -120;
  const meanP = sumP / n;
  return 10 * Math.log10(Math.max(1e-12, meanP));
}

function mapColor(name, t){
  switch(name){
    case 'viridis': return viridis(t);
    case 'magma': return magma(t);
    case 'grayscale': return grayscale(t);
    default: return turbo(t);
  }
}

/** ===================== Audio ===================== */
let analyzer = {
  file: null,
  url: null,
  audio: null,          // analysis audio element
  audioCtx: null,
  src: null,
  analyser: null,
  gain: null,
  inited: false,
  duration: 0,
  analysisPlaying: false,
};

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

async function initAnalyzerForFile(file) {
  if (analyzer.url) { try { URL.revokeObjectURL(analyzer.url); } catch {} }
  analyzer.url = URL.createObjectURL(file);

  if (!analyzer.audio) analyzer.audio = document.createElement('audio');
  analyzer.audio.src = analyzer.url;
  analyzer.audio.preload = 'auto';
  analyzer.audio.loop = false;
  analyzer.audio.volume = 1.0;
  analyzer.audio.muted = false; // mutedだと解析が止まる環境があるので gain=0で無音化

  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const ng = () => { cleanup(); reject(new Error('解析用audioの準備に失敗')); };
    const cleanup = () => {
      analyzer.audio.removeEventListener('canplay', ok);
      analyzer.audio.removeEventListener('error', ng);
    };
    analyzer.audio.addEventListener('canplay', ok, { once:true });
    analyzer.audio.addEventListener('error', ng, { once:true });
    analyzer.audio.load();
  });

  if (!analyzer.audioCtx) {
    analyzer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyzer.src = analyzer.audioCtx.createMediaElementSource(analyzer.audio);
    analyzer.analyser = analyzer.audioCtx.createAnalyser();
    analyzer.gain = analyzer.audioCtx.createGain();
    analyzer.gain.gain.value = 0.0; // 無音
    analyzer.src.connect(analyzer.analyser);
    analyzer.analyser.connect(analyzer.gain);
    analyzer.gain.connect(analyzer.audioCtx.destination);
  }

  analyzer.file = file;
  analyzer.inited = true;
}

async function ensureAnalysisPlaybackStarted() {
  if (!analyzer.inited) return;
  if (analyzer.audioCtx && analyzer.audioCtx.state === 'suspended') {
    try { await analyzer.audioCtx.resume(); } catch {}
  }
  if (analyzer.analysisPlaying) return;

  try {
    // USER gesture (prepareクリック内)で一回だけ開始
    await analyzer.audio.play();
    analyzer.analysisPlaying = true;
    logLine('解析用再生: START（無音）');
  } catch (e) {
    analyzer.analysisPlaying = false;
    logLine(`解析用再生: START失敗（この場合タイル解析は進みません）: ${e?.message ?? e}`);
  }
}

/** ===================== Tile cache (LRU) ===================== */
const tileCache = new Map();
let tileInFlight = new Set();
let abortCtrl = null;

// bird-friendly fixed resolution inside tile bitmap
const TILE_H = 512;
const FEATURE_BANDS = 48; // タイル内の周波数を粗くバンド化してスキャン高速化


function makeTileKey(tileIndex, cfg) {
  return [
    tileIndex,
    cfg.fftSize, cfg.fps,
    cfg.minHz, cfg.maxHz,
    cfg.minDb, cfg.maxDb,
    cfg.tileSec,
    cfg.colorMap,
    cfg.freqScale
  ].join('|');
}
function lruPrune(maxTiles) {
  if (tileCache.size <= maxTiles) return;
  const arr = Array.from(tileCache.entries()).map(([k,v]) => ({k, t:v.lastUsed}));
  arr.sort((a,b)=>a.t-b.t);
  const removeCount = tileCache.size - maxTiles;
  for (let i=0;i<removeCount;i++){
    const k = arr[i].k;
    const v = tileCache.get(k);
    if (v?.bitmap?.close) { try { v.bitmap.close(); } catch {} }
    tileCache.delete(k);
  }
}

/** ===================== Config ===================== */
function getConfig() {
  const fftSize = clamp(parseInt(UI.fftSize.value,10) || 1024, 512, 8192);
  const fps = clamp(parseInt(UI.fps.value,10) || 60, 10, 120);
  const minHz = clamp(parseInt(UI.minHz.value,10) || 2000, 0, 24000);
  const maxHz = clamp(parseInt(UI.maxHz.value,10) || 12000, 0, 24000);
  const minDb = clamp(parseInt(UI.minDb.value,10) || -100, -120, -10);
  const maxDb = clamp(parseInt(UI.maxDb.value,10) || -25, -120, 0);
  const pxPerSec = clamp(parseInt(UI.pxPerSec.value,10) || 120, 20, 400);
  const tileSec = clamp(parseInt(UI.tileSec.value,10) || 5, 2, 20);
  const cacheTiles = clamp(parseInt(UI.cacheTiles.value,10) || 80, 10, 300);
  const colorMap = UI.colorMap.value || 'turbo';
  const freqScale = UI.freqScale.value || 'log';
  const bandHighlight = !!UI.bandHighlight.checked;
  const birdMinHz = clamp(parseInt(UI.birdMinHz.value,10) || 2500, 0, 24000);
  const birdMaxHz = clamp(parseInt(UI.birdMaxHz.value,10) || 9000, 0, 24000);

  return {
    fftSize, fps,
    minHz: Math.min(minHz, maxHz),
    maxHz: Math.max(minHz, maxHz),
    minDb: Math.min(minDb, maxDb),
    maxDb: Math.max(minDb, maxDb),
    pxPerSec,
    tileSec,
    cacheTiles,
    colorMap,
    freqScale,
    bandHighlight,
    birdMinHz: Math.min(birdMinHz, birdMaxHz),
    birdMaxHz: Math.max(birdMinHz, birdMaxHz),
  };
}

/** ===================== Canvas helpers ===================== */
const AXIS_W = 62;
const PAD_T = 10;
const PAD_B = 14;
const GRID_ALPHA = 0.18;

function resizeCanvasToViewport() {
  const vp = UI.viewport.getBoundingClientRect();
  const w = Math.max(200, Math.floor(vp.width));
  const h = Math.max(240, Math.floor(vp.height));
  UI.specCanvas.width = w;
  UI.specCanvas.height = h;
}

function hzToY(hz, cfg, plotH) {
  const minHz = Math.max(1, cfg.minHz);
  const maxHz = Math.max(minHz+1, cfg.maxHz);
  let t;
  if (cfg.freqScale === 'log') {
    const a = Math.log(minHz);
    const b = Math.log(maxHz);
    t = (Math.log(Math.max(1, hz)) - a) / Math.max(1e-6, (b - a));
  } else {
    t = (hz - minHz) / Math.max(1e-6, (maxHz - minHz));
  }
  return PAD_T + (1 - clamp(t,0,1)) * plotH;
}

function drawAxis(ctx, cfg, plotH, canvasW, canvasH) {
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(0,0,AXIS_W,canvasH);

  ctx.strokeStyle = 'rgba(0,0,0,.08)';
  ctx.beginPath();
  ctx.moveTo(AXIS_W + 0.5, 0);
  ctx.lineTo(AXIS_W + 0.5, canvasH);
  ctx.stroke();

  const range = cfg.maxHz - cfg.minHz;
  const step = (range <= 6000) ? 500 : 1000;

  ctx.fillStyle = 'rgba(0,0,0,.70)';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  ctx.strokeStyle = `rgba(0,0,0,${GRID_ALPHA})`;
  ctx.lineWidth = 1;

  for (let hz = Math.ceil(cfg.minHz/step)*step; hz <= cfg.maxHz; hz += step) {
    const y = hzToY(hz, cfg, plotH);
    ctx.beginPath();
    ctx.moveTo(AXIS_W, y + 0.5);
    ctx.lineTo(canvasW, y + 0.5);
    ctx.stroke();

    const khz = (hz/1000).toFixed(step===500 ? 1 : 0);
    ctx.fillText(`${khz}`, 10, y + 4);
  }

  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillText('kHz', 10, 16);
}

function drawTimeTopGrid(ctx, cfg, viewStartSec, viewEndSec, canvasW, canvasH) {
  const plotX0 = AXIS_W;
  const spanSec = (viewEndSec - viewStartSec);
  const step = (spanSec <= 20) ? 1 : (spanSec <= 120 ? 5 : 10);

  ctx.save();
  ctx.strokeStyle = `rgba(0,0,0,${GRID_ALPHA})`;
  ctx.lineWidth = 1;

  const first = Math.floor(viewStartSec/step)*step;
  for (let t=first; t<=viewEndSec; t+=step){
    const x = plotX0 + (t - viewStartSec) * cfg.pxPerSec;
    ctx.beginPath();
    ctx.moveTo(x+0.5, 0);
    ctx.lineTo(x+0.5, canvasH);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.60)';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  for (let t=first; t<=viewEndSec; t+=step){
    const x = plotX0 + (t - viewStartSec) * cfg.pxPerSec;
    ctx.fillText(secToHMS(t), x + 6, 16);
  }
  ctx.restore();
}

function drawBandHighlight(ctx, cfg, plotH, canvasW) {
  if (!cfg.bandHighlight) return;
  const y1 = hzToY(cfg.birdMaxHz, cfg, plotH);
  const y2 = hzToY(cfg.birdMinHz, cfg, plotH);
  const top = Math.min(y1,y2);
  const h = Math.max(2, Math.abs(y2-y1));
  ctx.save();
  ctx.fillStyle = 'rgba(255, 230, 0, 0.10)';
  ctx.fillRect(AXIS_W, top, canvasW-AXIS_W, h);
  ctx.strokeStyle = 'rgba(255, 230, 0, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(AXIS_W+0.5, top+0.5, canvasW-AXIS_W-1, h-1);
  ctx.restore();
}


function drawDetectionsOverlay(ctx, cfg, viewStartSec, viewEndSec, canvasW, canvasH){
  if (!scanHits || scanHits.length === 0) return;
  ctx.save();
  // region fill
  ctx.fillStyle = 'rgba(255, 80, 80, 0.10)';
  ctx.strokeStyle = 'rgba(255, 80, 80, 0.55)';
  ctx.lineWidth = 1;

  for (const h of scanHits){
    if (h.end < viewStartSec || h.start > viewEndSec) continue;
    const x0 = AXIS_W + (Math.max(h.start, viewStartSec) - viewStartSec) * cfg.pxPerSec;
    const x1 = AXIS_W + (Math.min(h.end, viewEndSec) - viewStartSec) * cfg.pxPerSec;
    const w = Math.max(1, x1 - x0);
    ctx.fillRect(x0, 0, w, canvasH);
    // peak line
    const xp = AXIS_W + (clamp(h.peakTime, viewStartSec, viewEndSec) - viewStartSec) * cfg.pxPerSec;
    ctx.beginPath();
    ctx.moveTo(xp + 0.5, 0);
    ctx.lineTo(xp + 0.5, canvasH);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayhead(ctx, cfg, viewStartSec, currentTimeSec, canvasW, canvasH) {
  const x = AXIS_W + (currentTimeSec - viewStartSec) * cfg.pxPerSec;
  if (x < AXIS_W || x > canvasW) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,0,0,.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x+0.5, 0);
  ctx.lineTo(x+0.5, canvasH);
  ctx.stroke();
  ctx.restore();
}

function getVisibleTimeRange(cfg) {
  const scrollLeft = UI.viewport.scrollLeft;
  const viewW = UI.viewport.clientWidth;
  const startSec = scrollLeft / cfg.pxPerSec;
  const endSec = (scrollLeft + viewW) / cfg.pxPerSec;
  return { startSec, endSec };
}

/** ===================== Tile generation (NO play() per tile) ===================== */
function yToHzByScale(y, cfg, height){
  const t = 1 - (y / Math.max(1, (height - 1))); // 0 bottom -> min, 1 top -> max
  const minHz = Math.max(1, cfg.minHz);
  const maxHz = Math.max(minHz+1, cfg.maxHz);
  if (cfg.freqScale === 'log'){
    const a = Math.log(minHz);
    const b = Math.log(maxHz);
    return Math.exp(a + (b-a)*t);
  }
  return minHz + (maxHz - minHz) * t;
}

async function generateTileBitmap(tileIndex, cfg, abortSignal) {
  // Require analysis playback already started
  if (!analyzer.analysisPlaying) throw new Error('解析用再生が開始できていません（prepare後にブロック）');

  const tileStart = tileIndex * cfg.tileSec;
  const tileEnd = Math.min(analyzer.duration, tileStart + cfg.tileSec);
  const targetSeconds = tileEnd - tileStart;

  analyzer.analyser.fftSize = cfg.fftSize;
  analyzer.analyser.smoothingTimeConstant = 0;
  analyzer.analyser.minDecibels = cfg.minDb;
  analyzer.analyser.maxDecibels = cfg.maxDb;

  const bins = analyzer.analyser.frequencyBinCount;
  const tmp = new Float32Array(bins);
  const binHz = analyzer.audioCtx.sampleRate / cfg.fftSize;
  const featEdges = buildFeatureBands(cfg);
  const featCols = new Array(width); // each is Uint16Array(FEATURE_BANDS)

  const width = Math.max(1, Math.floor(targetSeconds * cfg.fps));
  const height = TILE_H;
  const hopMs = 1000 / cfg.fps;

  const oc = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(width, height)
    : (() => { const c=document.createElement('canvas'); c.width=width; c.height=height; return c; })();
  const ctx = oc.getContext('2d', { willReadFrequently:false });
  const img = ctx.createImageData(width, height);
  const data = img.data;

  const invRange = 1.0 / Math.max(1e-6, (cfg.maxDb - cfg.minDb));

  let stop = false;
  const onAbort = () => { stop = true; };
  abortSignal?.addEventListener('abort', onAbort, { once:true });

  try {
    // seek while playing
    analyzer.audio.currentTime = Math.max(0, tileStart);
    await sleep(120); // wait for seek settle

    const startT = nowMs();
    let nextSample = startT;
    let x = 0;

    while (!stop && x < width) {
      const now = nowMs();
      const elapsed = (now - startT)/1000;
      if (elapsed >= targetSeconds) break;

      if (now >= nextSample) {
        analyzer.analyser.getFloatFrequencyData(tmp);
        featCols[x] = spectrumToFeatureBands(tmp, cfg, featEdges);

        for (let y=0; y<height; y++){
          const hz = yToHzByScale(y, cfg, height);
          const bin = clamp(Math.round(hz / binHz), 0, bins-1);
          const db = tmp[bin];
          const norm = clamp((db - cfg.minDb) * invRange, 0, 1);
          const [r,g,b] = mapColor(cfg.colorMap, norm);
          const idx = (y * width + x) * 4;
          data[idx+0] = r;
          data[idx+1] = g;
          data[idx+2] = b;
          data[idx+3] = 255;
        }

        x++;
        nextSample += hopMs;
      }
      await sleep(6);
    }

    // extend last col to avoid blank tail
    if (x > 0 && x < width) {
      // extend features too
      const lastFeat = featCols[x-1];
      for (let fillX = x; fillX < width; fillX++){ featCols[fillX] = lastFeat; }

      const lastCol = x-1;
      for (let fillX = x; fillX < width; fillX++){
        for (let y=0; y<height; y++){
          const src = (y * width + lastCol) * 4;
          const dst = (y * width + fillX) * 4;
          data[dst+0]=data[src+0];
          data[dst+1]=data[src+1];
          data[dst+2]=data[src+2];
          data[dst+3]=255;
        }
      }
    }

    ctx.putImageData(img, 0, 0);
    const bitmap = await createImageBitmap(oc);
    return { bitmap, width, height, tileIndex, tileStart, tileSec: cfg.tileSec, lastUsed: nowMs(), featEdges, featCols };
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

/** ===================== Rendering ===================== */

let scanAbort = null;
let scanRunning = false;
let scanHits = []; // {start,end,peakDb,peakTime}

function setScanUI(running){
  scanRunning = running;
  if (UI.scanBtn) UI.scanBtn.disabled = !analyzer.inited || running;
  if (UI.scanStopBtn) UI.scanStopBtn.disabled = !running;
  if (UI.scanMinHz) UI.scanMinHz.disabled = running;
  if (UI.scanMaxHz) UI.scanMaxHz.disabled = running;
  if (UI.scanThresholdDb) UI.scanThresholdDb.disabled = running;
  if (UI.scanStepSec) UI.scanStepSec.disabled = running;
  if (UI.presetSmallBird) UI.presetSmallBird.disabled = running;
  if (UI.presetRaptor) UI.presetRaptor.disabled = running;
  if (UI.presetAll) UI.presetAll.disabled = running;
}

function updateDetectList(){
  if (!UI.detectCount || !UI.detectList) return;
  UI.detectCount.textContent = `${scanHits.length}件`;
  UI.detectList.innerHTML = '';
  for (let i=0;i<scanHits.length;i++){
    const h = scanHits[i];
    const div = document.createElement('div');
    div.className = 'hit';
    const t = document.createElement('div');
    t.className = 't mono';
    t.textContent = `${secToHMS(h.start)}–${secToHMS(h.end)}`;
    const v = document.createElement('div');
    v.className = 'v mono';
    v.textContent = `peak:${h.peakDb.toFixed(1)}dB`;
    div.appendChild(t);
    div.appendChild(v);
    div.addEventListener('click', async () => {
      const cfg = getConfig();
      const x = h.start * cfg.pxPerSec;
      UI.viewport.scrollLeft = Math.max(0, x - 120);
      await playFrom(h.start);
    });
    UI.detectList.appendChild(div);
  }
}

function bandMeanDbFromSpectrum(tmpDb, cfg, minHz, maxHz){
  const sr = analyzer.audioCtx.sampleRate;
  const binHz = sr / cfg.fftSize;
  const bins = tmpDb.length;
  const lo = clamp(Math.floor(minHz / binHz), 0, bins-1);
  const hi = clamp(Math.ceil(maxHz / binHz), 0, bins-1);
  if (hi <= lo) return -120;

  let sumP = 0;
  let n = 0;
  for (let i=lo;i<=hi;i++){
    const db = tmpDb[i];
    const p = Math.pow(10, (Math.max(-120, db) / 10));
    sumP += p;
    n++;
  }
  const meanP = sumP / Math.max(1, n);
  const meanDb = 10 * Math.log10(Math.max(1e-12, meanP));
  return meanDb;
}

async function runScanAsync(){
  if (!analyzer.inited) return;
  if (!analyzer.analysisPlaying){
    logLine('スキャン前に「読み込み/準備」で解析用再生を開始してください');
    return;
  }

  const cfg = getConfig();
  const scanMinHz = clamp(parseInt(UI.scanMinHz.value,10) || 3000, 0, 24000);
  const scanMaxHzUser = UI.scanMaxHz ? clamp(parseInt(UI.scanMaxHz.value,10) || cfg.maxHz, 0, 24000) : cfg.maxHz;
  const scanMaxHz = Math.max(scanMinHz, Math.min(cfg.maxHz, scanMaxHzUser));
  const thresholdDb = clamp(parseInt(UI.scanThresholdDb.value,10) || -55, -120, 0);
  const stepSec = clamp(parseFloat(UI.scanStepSec.value) || 0.5, 0.1, 2.0);

  analyzer.analyser.fftSize = cfg.fftSize;
  analyzer.analyser.smoothingTimeConstant = 0;
  analyzer.analyser.minDecibels = cfg.minDb;
  analyzer.analyser.maxDecibels = cfg.maxDb;

  const bins = analyzer.analyser.frequencyBinCount;
  const tmp = new Float32Array(bins);

  scanHits = [];
  updateDetectList();
  if (UI.scanBarFill) UI.scanBarFill.style.width = '0%';
  if (UI.scanStatus) UI.scanStatus.textContent = `scan: 0/${secToHMS(analyzer.duration)} step=${stepSec}s band=${scanMinHz}-${scanMaxHz}Hz thr=${thresholdDb}dB`;

  scanAbort = new AbortController();
  setScanUI(true);
  setState('スキャン中');

  try{
    const dur = analyzer.duration;
    const groupGap = Math.max(stepSec * 1.5, 0.75);
    let cur = null;
    let t = 0;
    let iter = 0;

    analyzer.audio.currentTime = 0;
    await sleep(120);

    while (t < dur){
      if (scanAbort.signal.aborted) break;

      // 既にタイルが生成済みなら（featCols）を再利用して高速判定
      let meanDb = null;
      let peak = null;

      const ti = Math.floor(t / cfg.tileSec);
      const key = makeTileKey(ti, cfg);
      const tile = tileCache.get(key);
      if (tile && tile.featCols && tile.featEdges){
        const col = Math.floor((t - (ti*cfg.tileSec)) * cfg.fps);
        const idx = clamp(col, 0, tile.featCols.length - 1);
        const fb = tile.featCols[idx];
        meanDb = featureBandsToMeanDb(fb, cfg, tile.featEdges, scanMinHz, scanMaxHz);

        // peak推定: 選択バンド内で最大dB
        let best = -120;
        for (let bi=0; bi<FEATURE_BANDS; bi++){
          const loHz = tile.featEdges[bi];
          const hiHz = tile.featEdges[bi+1];
          if (hiHz <= scanMinHz || loHz >= scanMaxHz) continue;
          const db = (fb[bi] - 12000) / 100;
          if (db > best) best = db;
        }
        peak = best;
      }

      if (meanDb === null){
        analyzer.audio.currentTime = t;
        await sleep(80);
        analyzer.analyser.getFloatFrequencyData(tmp);
        meanDb = bandMeanDbFromSpectrum(tmp, cfg, scanMinHz, scanMaxHz);

        // peak db in band for display
        const sr = analyzer.audioCtx.sampleRate;
        const binHz = sr / cfg.fftSize;
        const lo = clamp(Math.floor(scanMinHz / binHz), 0, bins-1);
        const hi = clamp(Math.ceil(scanMaxHz / binHz), 0, bins-1);
        let pk = -120;
        for (let i=lo;i<=hi;i++){
          const db = tmp[i];
          if (db > pk) pk = db;
        }
        peak = pk;
      }

      if (meanDb >= thresholdDb){
        const peakDbVal = (peak === null || peak === undefined) ? meanDb : peak;

        if (!cur){
          cur = { start: t, end: t, peakDb: peakDbVal, peakTime: t };
        } else if (t - cur.end <= groupGap){
          cur.end = t;
          if (peakDbVal > cur.peakDb){ cur.peakDb = peakDbVal; cur.peakTime = t; }
        } else {
          scanHits.push({ ...cur, end: Math.min(cur.end + stepSec, dur) });
          cur = { start: t, end: t, peakDb: peakDbVal, peakTime: t };
        }
      }

      t += stepSec;
      iter++;

      if (iter % 10 === 0){
        const p = clamp(t / dur, 0, 1);
        if (UI.scanBarFill) UI.scanBarFill.style.width = `${(p*100).toFixed(1)}%`;
        if (UI.scanStatus) UI.scanStatus.textContent = `scan: ${secToHMS(t)}/${secToHMS(dur)} hits=${scanHits.length}${cur?'+':''}`;
        await sleep(0);
      }
    }

    if (cur) scanHits.push({ ...cur, end: Math.min(cur.end + stepSec, analyzer.duration) });

    updateDetectList();
    if (UI.scanBarFill) UI.scanBarFill.style.width = '100%';
    if (UI.scanStatus) UI.scanStatus.textContent = `scan: 完了 hits=${scanHits.length}`;
    setState('準備完了');
    logLine(`スキャン完了: ${scanHits.length}件`);
  } catch(e){
    setState('エラー');
    logLine(`スキャン失敗: ${e?.message ?? e}`);
  } finally {
    setScanUI(false);
    scanAbort = null;
  }
}

let renderQueued = false;
let playingRaf = 0;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderViewport(UI.specCanvas);
  });
}

function updateLabels(range) {
  UI.viewLabel.textContent = `${secToHMS(range.startSec)} - ${secToHMS(range.endSec)}`;
}

async function ensureTilesForRange(cfg, range) {
  const startIdx = Math.floor(range.startSec / cfg.tileSec);
  const endIdx = Math.floor(range.endSec / cfg.tileSec);

  UI.tileLabel.textContent = `${startIdx}..${endIdx}（cache:${tileCache.size} / inflight:${tileInFlight.size}）`;
  lruPrune(cfg.cacheTiles);

  for (let ti = startIdx; ti <= endIdx; ti++) {
    if (abortCtrl?.signal?.aborted) return;

    const key = makeTileKey(ti, cfg);
    const hit = tileCache.get(key);
    if (hit) { hit.lastUsed = nowMs(); continue; }
    if (tileInFlight.has(key)) continue;

    // throttle inflight (1 is safest because we are seeking a single audio element)
    if (tileInFlight.size >= 1) continue;

    tileInFlight.add(key);
    (async () => {
      try {
        logLine(`tile#${ti} 生成開始`);
        const tile = await generateTileBitmap(ti, cfg, abortCtrl?.signal);
        tileCache.set(key, tile);
        tile.lastUsed = nowMs();
        logLine(`tile#${ti} 生成OK`);
      } catch (e) {
        logLine(`tile#${ti} 生成失敗: ${e?.message ?? e}`);
      } finally {
        tileInFlight.delete(key);
        scheduleRender();
      }
    })();
  }
}

function renderViewport(targetCanvas) {
  if (!analyzer.inited) return;

  const cfg = getConfig();
  if (targetCanvas === UI.specCanvas) resizeCanvasToViewport();

  const ctx = targetCanvas.getContext('2d', { alpha:false, willReadFrequently:false });
  const cw = targetCanvas.width, ch = targetCanvas.height;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,cw, ch);

  const plotH = Math.max(1, ch - PAD_T - PAD_B);
  const range = getVisibleTimeRange(cfg);
  if (targetCanvas === UI.specCanvas) updateLabels(range);

  drawAxis(ctx, cfg, plotH, cw, ch);
  drawTimeTopGrid(ctx, cfg, range.startSec, range.endSec, cw, ch);
  drawBandHighlight(ctx, cfg, plotH, cw);

  ensureTilesForRange(cfg, range);

  const startIdx = Math.floor(range.startSec / cfg.tileSec);
  const endIdx = Math.floor(range.endSec / cfg.tileSec);
  const plotX0 = AXIS_W;

  for (let ti = startIdx; ti <= endIdx; ti++){
    const key = makeTileKey(ti, cfg);
    const tile = tileCache.get(key);
    if (!tile) continue;
    tile.lastUsed = nowMs();

    const tileStart = ti * cfg.tileSec;
    const tileEnd = tileStart + cfg.tileSec;
    const drawStart = Math.max(range.startSec, tileStart);
    const drawEnd = Math.min(range.endSec, tileEnd);
    if (drawEnd <= drawStart) continue;

    const srcX0 = (drawStart - tileStart) * cfg.fps;
    const srcX1 = (drawEnd - tileStart) * cfg.fps;
    const srcW = Math.max(1, srcX1 - srcX0);

    const dstX0 = plotX0 + (drawStart - range.startSec) * cfg.pxPerSec;
    const dstW = (drawEnd - drawStart) * cfg.pxPerSec;

    ctx.drawImage(tile.bitmap, srcX0, 0, srcW, tile.height, dstX0, PAD_T, dstW, plotH);
  }

  drawDetectionsOverlay(ctx, cfg, range.startSec, range.endSec, cw, ch);

  const t = UI.fullAudio.currentTime || 0;
  drawPlayhead(ctx, cfg, range.startSec, t, cw, ch);

  if (analyzer.duration > 0 && targetCanvas === UI.specCanvas) {
    const p = clamp(t / analyzer.duration, 0, 1);
    UI.barFill.style.width = `${(p*100).toFixed(1)}%`;
  }
}

/** ===================== Playback sync ===================== */
function startPlayheadLoop() {
  if (playingRaf) return;
  const loop = () => {
    playingRaf = requestAnimationFrame(loop);
    if (!analyzer.inited) return;
    if (UI.fullAudio.paused) return;

    const cfg = getConfig();
    const t = UI.fullAudio.currentTime || 0;
    const x = t * cfg.pxPerSec;
    const left = UI.viewport.scrollLeft;
    const right = left + UI.viewport.clientWidth;
    const margin = 140;

    if (x < left + margin) UI.viewport.scrollLeft = Math.max(0, x - margin);
    else if (x > right - margin) UI.viewport.scrollLeft = Math.max(0, x - (UI.viewport.clientWidth - margin));

    scheduleRender();
  };
  playingRaf = requestAnimationFrame(loop);
}
function stopPlayheadLoop() {
  if (playingRaf) { cancelAnimationFrame(playingRaf); playingRaf = 0; }
}

async function playFrom(timeSec) {
  if (!analyzer.inited) return;
  UI.fullAudio.style.display = 'block';
  UI.fullAudio.currentTime = clamp(timeSec, 0, analyzer.duration);
  await sleep(40);
  try { await UI.fullAudio.play(); }
  catch (e) { logLine(`再生失敗: ${e?.message ?? e}`); return; }
  startPlayheadLoop();
  scheduleRender();
}

/** ===================== Export PNG (visible) ===================== */
async function exportVisiblePNG() {
  if (!analyzer.inited) return;
  setState('PNG作成中');
  UI.exportViewBtn.disabled = true;
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = true;
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = true;
  if (UI.scanBtn) UI.scanBtn.disabled = true;
  if (UI.scanStopBtn) UI.scanStopBtn.disabled = true;
  if (UI.scanBarFill) UI.scanBarFill.style.width = '0%';
  if (UI.scanStatus) UI.scanStatus.textContent = 'scan: -';
  if (UI.detectList) UI.detectList.innerHTML='';
  if (UI.detectCount) UI.detectCount.textContent='0件';
  try {
    const w = UI.specCanvas.width;
    const h = UI.specCanvas.height;

    const oc = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : (() => { const c=document.createElement('canvas'); c.width=w; c.height=h; return c; })();

    renderViewport(oc);
    const blob = await (oc.convertToBlob ? oc.convertToBlob({ type:'image/png' }) : new Promise(r => oc.toBlob(r, 'image/png')));

    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    downloadBlob(blob, `spectrogram_view_${stamp}.png`);
    setState('完了');
  } catch (e) {
    setState('エラー');
    logLine(`PNG失敗: ${e?.message ?? e}`);
  } finally {
    UI.exportViewBtn.disabled = false;
    UI.exportRangeBtn.disabled = false;
    if (UI.scanBtn) UI.scanBtn.disabled = false;
  }
}


async function exportRangePNG() {
  if (!analyzer.inited) return;
  setState('PNG作成中');
  UI.exportRangeBtn.disabled = true;
  try {
    const cfg = getConfig();
    const start = clamp(parseFloat(UI.exportStartSec.value) || 0, 0, analyzer.duration);
    const end = clamp(parseFloat(UI.exportEndSec.value) || Math.min(analyzer.duration, start + 30), 0, analyzer.duration);
    const a = Math.min(start, end);
    const b = Math.max(start, end);
    const span = Math.max(0.1, b - a);

    // cap width to avoid huge memory
    const desiredW = Math.floor(span * cfg.pxPerSec) + AXIS_W;
    const maxW = 8000;
    const scale = desiredW > maxW ? (maxW / desiredW) : 1.0;

    const vp = UI.viewport.getBoundingClientRect();
    const h = Math.max(240, Math.floor(vp.height));
    const w = Math.max(600, Math.floor(desiredW * scale));

    const oc = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : (() => { const c=document.createElement('canvas'); c.width=w; c.height=h; return c; })();

    // render range with adjusted pxPerSec
    const cfg2 = { ...cfg, pxPerSec: cfg.pxPerSec * scale };
    renderRangeToCanvas(oc, cfg2, a, b);

    const blob = await (oc.convertToBlob ? oc.convertToBlob({ type:'image/png' }) : new Promise(r => oc.toBlob(r, 'image/png')));
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    downloadBlob(blob, `spectrogram_${a.toFixed(0)}-${b.toFixed(0)}s_${stamp}.png`);
    setState('完了');
  } catch (e) {
    setState('エラー');
    logLine(`PNG(範囲)失敗: ${e?.message ?? e}`);
  } finally {
    UI.exportRangeBtn.disabled = false;
  }
}

function renderRangeToCanvas(targetCanvas, cfg, startSec, endSec){
  const ctx = targetCanvas.getContext('2d', { alpha:false, willReadFrequently:false });
  const cw = targetCanvas.width, ch = targetCanvas.height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,cw,ch);

  const plotH = Math.max(1, ch - PAD_T - PAD_B);
  const range = { startSec, endSec };

  drawAxis(ctx, cfg, plotH, cw, ch);
  drawTimeTopGrid(ctx, cfg, range.startSec, range.endSec, cw, ch);
  drawBandHighlight(ctx, cfg, plotH, cw);

  const startIdx = Math.floor(range.startSec / cfg.tileSec);
  const endIdx = Math.floor(range.endSec / cfg.tileSec);
  const plotX0 = AXIS_W;

  for (let ti = startIdx; ti <= endIdx; ti++){
    const keyFull = makeTileKey(ti, cfg);
    let tile = tileCache.get(keyFull);
    if (!tile) continue;

    const tileStart = ti * cfg.tileSec;
    const tileEnd = tileStart + cfg.tileSec;
    const drawStart = Math.max(range.startSec, tileStart);
    const drawEnd = Math.min(range.endSec, tileEnd);
    if (drawEnd <= drawStart) continue;

    const srcX0 = (drawStart - tileStart) * cfg.fps;
    const srcX1 = (drawEnd - tileStart) * cfg.fps;
    const srcW = Math.max(1, srcX1 - srcX0);

    const dstX0 = plotX0 + (drawStart - range.startSec) * cfg.pxPerSec;
    const dstW = (drawEnd - drawStart) * cfg.pxPerSec;

    ctx.drawImage(tile.bitmap, srcX0, 0, srcW, tile.height, dstX0, PAD_T, dstW, plotH);
  }

  drawDetectionsOverlay(ctx, cfg, range.startSec, range.endSec, cw, ch);

  const t = UI.fullAudio.currentTime || 0;
  drawPlayhead(ctx, cfg, range.startSec, t, cw, ch);
}


/** ===================== UI events ===================== */
function clearAll() {
  try { UI.fullAudio.pause(); } catch {}
  stopPlayheadLoop();

  if (abortCtrl) abortCtrl.abort();
  abortCtrl = null;

  for (const [,v] of tileCache) {
    if (v?.bitmap?.close) { try { v.bitmap.close(); } catch {} }
  }
  tileCache.clear();
  tileInFlight = new Set();

  try { analyzer.audio?.pause(); } catch {}
  analyzer.analysisPlaying = false;

  analyzer.file = null;
  analyzer.inited = false;
  analyzer.duration = 0;

  UI.log.textContent = '';
  UI.barFill.style.width = '0%';
  UI.durLabel.textContent = '-';
  UI.viewLabel.textContent = '-';
  UI.tileLabel.textContent = '-';
  setState('待機');

  UI.fullAudio.style.display = 'none';

  UI.playBtn.disabled = true;
  UI.pauseBtn.disabled = true;
  UI.stopBtn.disabled = true;
  UI.exportViewBtn.disabled = true;
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = true;
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = true;
  if (UI.scanBtn) UI.scanBtn.disabled = true;
  if (UI.scanStopBtn) UI.scanStopBtn.disabled = true;
  if (UI.scanBarFill) UI.scanBarFill.style.width = '0%';
  if (UI.scanStatus) UI.scanStatus.textContent = 'scan: -';
  if (UI.detectList) UI.detectList.innerHTML='';
  if (UI.detectCount) UI.detectCount.textContent='0件';

  UI.spacer.style.width = '0px';
  UI.viewport.scrollLeft = 0;

  resizeCanvasToViewport();
  const ctx = UI.specCanvas.getContext('2d', { alpha:false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,UI.specCanvas.width, UI.specCanvas.height);
}

UI.clearBtn.addEventListener('click', clearAll);
UI.exportViewBtn.addEventListener('click', exportVisiblePNG);
UI.exportRangeBtn.addEventListener('click', exportRangePNG);

UI.prepareBtn.addEventListener('click', async () => {
  const file = UI.fileInput.files?.[0];
  if (!file) { alert('音声ファイルを選択してください'); return; }

  UI.prepareBtn.disabled = true;
  UI.playBtn.disabled = true;
  UI.pauseBtn.disabled = true;
  UI.stopBtn.disabled = true;
  UI.exportViewBtn.disabled = true;
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = true;
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = true;
  if (UI.scanBtn) UI.scanBtn.disabled = true;
  if (UI.scanStopBtn) UI.scanStopBtn.disabled = true;
  if (UI.scanBarFill) UI.scanBarFill.style.width = '0%';
  if (UI.scanStatus) UI.scanStatus.textContent = 'scan: -';
  if (UI.detectList) UI.detectList.innerHTML='';
  if (UI.detectCount) UI.detectCount.textContent='0件';

  abortCtrl = new AbortController();

  try {
    setState('準備中');
    logLine(`選択: ${file.name} (${fmtBytes(file.size)})`);

    const duration = await ensureFullAudioMetadata(file);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration取得に失敗');

    analyzer.duration = duration;
    UI.durLabel.textContent = `${duration.toFixed(2)}s`;

    await initAnalyzerForFile(file);
    await ensureAnalysisPlaybackStarted(); // ★重要（ユーザー操作内）

    const cfg = getConfig();
    const totalW = Math.max(1, Math.floor(duration * cfg.pxPerSec));
    UI.spacer.style.width = `${totalW}px`;
    UI.spacer.style.height = '100%';
    UI.viewport.scrollLeft = 0;

    UI.playBtn.disabled = false;
    UI.pauseBtn.disabled = false;
    UI.stopBtn.disabled = false;
    UI.exportViewBtn.disabled = false;
    UI.exportRangeBtn.disabled = false;
    if (UI.scanBtn) UI.scanBtn.disabled = false;

    setState('準備完了');
    resizeCanvasToViewport();
    scheduleRender();
    logLine('準備完了。スクロールするとタイル解析が進みます。');
  } catch (e) {
    setState('エラー');
    logLine(`準備失敗: ${e?.message ?? e}`);
  } finally {
    UI.prepareBtn.disabled = false;
  }
});

UI.playBtn.addEventListener('click', async () => {
  if (!analyzer.inited) return;
  await playFrom(UI.fullAudio.currentTime || 0);
});
UI.pauseBtn.addEventListener('click', () => {
  try { UI.fullAudio.pause(); } catch {}
  scheduleRender();
});
UI.stopBtn.addEventListener('click', () => {
  try { UI.fullAudio.pause(); UI.fullAudio.currentTime = 0; } catch {}
  stopPlayheadLoop();
  UI.viewport.scrollLeft = 0;
  scheduleRender();
});

UI.viewport.addEventListener('scroll', () => scheduleRender());
window.addEventListener('resize', () => scheduleRender());

// click-to-seek
UI.specCanvas.addEventListener('click', async (ev) => {
  if (!analyzer.inited) return;
  const cfg = getConfig();
  const rect = UI.specCanvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  if (x < AXIS_W) return;
  const time = (UI.viewport.scrollLeft + x - AXIS_W) / cfg.pxPerSec;
  await playFrom(time);
});

// settings change -> rerender + spacer update (zoom)
function onSettingChanged() {
  if (!analyzer.inited) { scheduleRender(); return; }
  const cfg = getConfig();
  const totalW = Math.max(1, Math.floor(analyzer.duration * cfg.pxPerSec));
  UI.spacer.style.width = `${totalW}px`;
  lruPrune(cfg.cacheTiles);
  scheduleRender();
}
['change','input'].forEach(evt => {
  UI.fftSize.addEventListener(evt, onSettingChanged);
  UI.fps.addEventListener(evt, onSettingChanged);
  UI.minHz.addEventListener(evt, onSettingChanged);
  UI.maxHz.addEventListener(evt, onSettingChanged);
  UI.minDb.addEventListener(evt, onSettingChanged);
  UI.maxDb.addEventListener(evt, onSettingChanged);
  UI.pxPerSec.addEventListener(evt, onSettingChanged);
  UI.tileSec.addEventListener(evt, onSettingChanged);
  UI.cacheTiles.addEventListener(evt, onSettingChanged);
  UI.colorMap.addEventListener(evt, onSettingChanged);
  UI.freqScale.addEventListener(evt, onSettingChanged);
  UI.bandHighlight.addEventListener(evt, onSettingChanged);
  UI.birdMinHz.addEventListener(evt, onSettingChanged);
  UI.birdMaxHz.addEventListener(evt, onSettingChanged);
});

UI.fullAudio.addEventListener('play', () => startPlayheadLoop());
UI.fullAudio.addEventListener('pause', () => scheduleRender());
UI.fullAudio.addEventListener('timeupdate', () => scheduleRender());
UI.fullAudio.addEventListener('ended', () => { stopPlayheadLoop(); scheduleRender(); });


// === Scan / presets ===
if (UI.presetSmallBird){
  UI.presetSmallBird.addEventListener('click', () => { UI.scanMinHz.value = 3000; if (UI.scanMaxHz) UI.scanMaxHz.value = 12000; });
  UI.presetRaptor.addEventListener('click', () => { UI.scanMinHz.value = 1500; if (UI.scanMaxHz) UI.scanMaxHz.value = 8000; });
  UI.presetAll.addEventListener('click', () => { UI.scanMinHz.value = 0; if (UI.scanMaxHz) UI.scanMaxHz.value = getConfig().maxHz; });
}
if (UI.scanBtn){
  UI.scanBtn.addEventListener('click', () => runScanAsync());
  UI.scanStopBtn.addEventListener('click', () => { if (scanAbort) scanAbort.abort(); });
}

clearAll();
