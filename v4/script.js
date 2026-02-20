/* eslint-disable no-console */
'use strict';

/**
 * v2 追加
 * - 色マップ（Turbo/Magma/Viridis/Gray）
 * - 対数周波数軸（log / linear 切替）
 * - 鳥声帯域の強調（帯域ハイライト）
 * - PNG書き出し（表示中ビューポート）
 *
 * 巨大ファイル対策
 * - 表示中レンジに必要なタイルだけ解析して描画
 * - タイルは bitmap のみキャッシュ（LRU）
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

  // band scan
  scanMinHz: document.getElementById('scanMinHz'),
  scanMaxHz: document.getElementById('scanMaxHz'),
  scanThreshold: document.getElementById('scanThreshold'),
  scanMinHzVal: document.getElementById('scanMinHzVal'),
  scanMaxHzVal: document.getElementById('scanMaxHzVal'),
  scanThresholdVal: document.getElementById('scanThresholdVal'),
  presetNight: document.getElementById('presetNight'),
  presetOwl: document.getElementById('presetOwl'),
  presetTora: document.getElementById('presetTora'),
  noiseStartSec: document.getElementById('noiseStartSec'),
  noiseEndSec: document.getElementById('noiseEndSec'),
  scanBtn: document.getElementById('scanBtn'),
  scanAbortBtn: document.getElementById('scanAbortBtn'),
  scanPct: document.getElementById('scanPct'),
  scanBar: document.getElementById('scanBar'),
  detectList: document.getElementById('detectList'),

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
// lightweight colormap functions (0..1 -> [r,g,b])
function turbo(t){
  // Approximation (same spirit as Turbo), clipped
  t = clamp(t,0,1);
  const r = clamp(34.61 + t*(1172.33 + t*(-10793.56 + t*(33300.12 + t*(-38394.49 + t*14825.05)))), 0, 255);
  const g = clamp(23.31 + t*(557.33 + t*(1225.33 + t*(-3574.96 + t*(1858.50 + t*0.00)))), 0, 255);
  const b = clamp(27.20 + t*(3211.10 + t*(-15327.97 + t*(27814.00 + t*(-22569.18 + t*6838.66)))), 0, 255);
  return [r|0, g|0, b|0];
}
function viridis(t){
  // small piecewise approximation via 5 anchors
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
function mapColor(name, t){
  switch(name){
    case 'viridis': return viridis(t);
    case 'magma': return magma(t);
    case 'grayscale': return grayscale(t);
    default: return turbo(t);
  }
}

/** ===================== Analyzer (seek) ===================== */
let analyzer = {
  file: null,
  url: null,
  audio: null,
  audioCtx: null,
  src: null,
  analyser: null,
  gain: null,
  inited: false,
  duration: 0,
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
  analyzer.audio.volume = 1.0;
  analyzer.audio.muted = false;

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
    analyzer.gain.gain.value = 0.0; // 無音化はGainで（muted禁止）
    analyzer.src.connect(analyzer.analyser);
    analyzer.analyser.connect(analyzer.gain);
    analyzer.gain.connect(analyzer.audioCtx.destination);
  }

  analyzer.file = file;
  analyzer.inited = true;
}

/** ===================== Tile cache (LRU) ===================== */
const tileCache = new Map();
let tileInFlight = new Set();

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

/** ===================== Spectrogram rendering ===================== */
const AXIS_W = 62;
const PAD_T = 10;
const PAD_B = 14;
const GRID_ALPHA = 0.18;

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

function drawAxis(ctx, cfg, plotH) {
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(0,0,AXIS_W,UI.specCanvas.height);

  ctx.strokeStyle = 'rgba(0,0,0,.08)';
  ctx.beginPath();
  ctx.moveTo(AXIS_W + 0.5, 0);
  ctx.lineTo(AXIS_W + 0.5, UI.specCanvas.height);
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
    ctx.lineTo(UI.specCanvas.width, y + 0.5);
    ctx.stroke();

    const khz = (hz/1000).toFixed(step===500 ? 1 : 0);
    ctx.fillText(`${khz}`, 10, y + 4);
  }

  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillText('kHz', 10, 16);
}

function drawTimeTopGrid(ctx, cfg, viewStartSec, viewEndSec) {
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
    ctx.lineTo(x+0.5, UI.specCanvas.height);
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

function drawBandHighlight(ctx, cfg, plotH) {
  if (!cfg.bandHighlight) return;
  const y1 = hzToY(cfg.birdMaxHz, cfg, plotH);
  const y2 = hzToY(cfg.birdMinHz, cfg, plotH);
  const top = Math.min(y1,y2);
  const h = Math.max(2, Math.abs(y2-y1));
  ctx.save();
  ctx.fillStyle = 'rgba(255, 230, 0, 0.10)';
  ctx.fillRect(AXIS_W, top, UI.specCanvas.width-AXIS_W, h);
  ctx.strokeStyle = 'rgba(255, 230, 0, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(AXIS_W+0.5, top+0.5, UI.specCanvas.width-AXIS_W-1, h-1);
  ctx.restore();
}

function drawPlayhead(ctx, cfg, viewStartSec, currentTimeSec) {
  const x = AXIS_W + (currentTimeSec - viewStartSec) * cfg.pxPerSec;
  if (x < AXIS_W || x > UI.specCanvas.width) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,0,0,.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x+0.5, 0);
  ctx.lineTo(x+0.5, UI.specCanvas.height);
  ctx.stroke();
  ctx.restore();
}

/** ===================== Tile generation ===================== */
let abortCtrl = null;

// fixed tile bitmap height (gives bird-friendly resolution)
const TILE_H = 512;

function yToHzByScale(y, cfg, plotH){
  // y: 0..(TILE_H-1) inside tile image; map to freq
  const t = 1 - (y / Math.max(1, (plotH - 1))); // 0 bottom -> min, 1 top -> max
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

  const hopMs = 1000 / cfg.fps;
  const width = Math.max(1, Math.floor(targetSeconds * cfg.fps));
  const height = TILE_H;

  const oc = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(width, height)
    : (() => { const c = document.createElement('canvas'); c.width=width; c.height=height; return c; })();

  const ctx = oc.getContext('2d', { willReadFrequently:false });
  const img = ctx.createImageData(width, height);
  const data = img.data;

  const invRange = 1.0 / Math.max(1e-6, (cfg.maxDb - cfg.minDb));

  let stop = false;
  const onAbort = () => { stop = true; };
  abortSignal?.addEventListener('abort', onAbort, { once:true });

  try {
    analyzer.audio.currentTime = Math.max(0, tileStart);
    await sleep(90);
    try { await analyzer.audio.play(); } catch (e) { /* Chrome autoplay guard */ }

    const startT = nowMs();
    let nextSample = startT;
    let x = 0;
    let lastCol = null;

    while (!stop) {
      const now = nowMs();
      const elapsed = (now - startT)/1000;
      if (elapsed >= targetSeconds) break;
      if (x >= width) break;

      if (now >= nextSample) {
        analyzer.analyser.getFloatFrequencyData(tmp);

        // Build one column directly into ImageData
        for (let y=0; y<height; y++){
          const hz = yToHzByScale(y, cfg, height);
          const bin = clamp(Math.round(hz / binHz), 0, bins-1);
          const db = tmp[bin];
          const norm = clamp((db - cfg.minDb) * invRange, 0, 1); // 0..1
          const [r,g,b] = mapColor(cfg.colorMap, norm);
          const idx = (y * width + x) * 4;
          data[idx+0] = r;
          data[idx+1] = g;
          data[idx+2] = b;
          data[idx+3] = 255;
        }

        lastCol = x;
        x++;
        nextSample += hopMs;
      }
      await sleep(6);
    }

    analyzer.audio.pause();

    // If we sampled less than width, extend last column to the right (avoid blank tail)
    if (lastCol !== null && lastCol < width-1) {
      for (let fillX = lastCol+1; fillX < width; fillX++){
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
    return {
      bitmap,
      width,
      height,
      tileIndex,
      tileStart,
      tileSec: cfg.tileSec,
      lastUsed: nowMs()
    };
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    try { analyzer.audio.pause(); } catch {}
  }
}

/** ===================== View rendering ===================== */
let renderQueued = false;
let playingRaf = 0;

function getVisibleTimeRange(cfg) {
  const scrollLeft = UI.viewport.scrollLeft;
  const viewW = UI.viewport.clientWidth;
  const startSec = scrollLeft / cfg.pxPerSec;
  const endSec = (scrollLeft + viewW) / cfg.pxPerSec;
  return { startSec, endSec };
}

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
    if (tileInFlight.size >= 2) continue;

    tileInFlight.add(key);
    (async () => {
      try {
        const tile = await generateTileBitmap(ti, cfg, abortCtrl?.signal);
        tileCache.set(key, tile);
        tile.lastUsed = nowMs();
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

  // ensure canvas size matches viewport (for main canvas only)
  if (targetCanvas === UI.specCanvas) resizeCanvasToViewport();

  const ctx = targetCanvas.getContext('2d', { alpha:false, willReadFrequently:false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,targetCanvas.width, targetCanvas.height);

  const plotH = Math.max(1, targetCanvas.height - PAD_T - PAD_B);
  const range = getVisibleTimeRange(cfg);
  if (targetCanvas === UI.specCanvas) updateLabels(range);

  // axis + grids
  drawAxis(ctx, cfg, plotH);
  drawTimeTopGrid(ctx, cfg, range.startSec, range.endSec);

  // optional highlight
  drawBandHighlight(ctx, cfg, plotH);

  // tiles needed
  ensureTilesForRange(cfg, range);

  // draw tiles intersecting
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

    // src in tile bitmap: width = tileSec * fps
    const srcX0 = (drawStart - tileStart) * cfg.fps;
    const srcX1 = (drawEnd - tileStart) * cfg.fps;
    const srcW = Math.max(1, srcX1 - srcX0);

    const dstX0 = plotX0 + (drawStart - range.startSec) * cfg.pxPerSec;
    const dstW = (drawEnd - drawStart) * cfg.pxPerSec;

    ctx.drawImage(
      tile.bitmap,
      srcX0, 0, srcW, tile.height,
      dstX0, PAD_T, dstW, plotH
    );
  }

  // playhead
  const t = UI.fullAudio.currentTime || 0;
  drawPlayhead(ctx, cfg, range.startSec, t);

  // progress bar
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
  try {
    // Render to offscreen at same resolution as current canvas
    const w = UI.specCanvas.width;
    const h = UI.specCanvas.height;

    const oc = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : (() => { const c=document.createElement('canvas'); c.width=w; c.height=h; return c; })();

    // Important: we render the current view (based on viewport scroll)
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
  }
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

  UI.spacer.style.width = '0px';
  UI.viewport.scrollLeft = 0;

  // clear canvas
  resizeCanvasToViewport();
  const ctx = UI.specCanvas.getContext('2d', { alpha:false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,UI.specCanvas.width, UI.specCanvas.height);
}

UI.clearBtn.addEventListener('click', clearAll);
UI.exportViewBtn.addEventListener('click', exportVisiblePNG);

UI.prepareBtn.addEventListener('click', async () => {
  const file = UI.fileInput.files?.[0];
  if (!file) { alert('音声ファイルを選択してください'); return; }

  UI.prepareBtn.disabled = true;
  UI.playBtn.disabled = true;
  UI.pauseBtn.disabled = true;
  UI.stopBtn.disabled = true;
  UI.exportViewBtn.disabled = true;
  UI.scanBtn.disabled = true;
  UI.scanAbortBtn.disabled = true;

  abortCtrl = new AbortController();

  try {
    setState('準備中');
    logLine(`選択: ${file.name} (${fmtBytes(file.size)})`);

    const duration = await ensureFullAudioMetadata(file);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration取得に失敗');

    analyzer.duration = duration;
    UI.durLabel.textContent = `${duration.toFixed(2)}s`;

    await initAnalyzerForFile(file);
  if (analyzer.audioCtx && analyzer.audioCtx.state === 'suspended') {
    try { await analyzer.audioCtx.resume(); } catch(e){}
  }


    const cfg = getConfig();
    const totalW = Math.max(1, Math.floor(duration * cfg.pxPerSec));
    UI.spacer.style.width = `${totalW}px`;
    UI.spacer.style.height = '100%';
    UI.viewport.scrollLeft = 0;

    UI.playBtn.disabled = false;
    UI.pauseBtn.disabled = false;
    UI.stopBtn.disabled = false;
    UI.exportViewBtn.disabled = false;
    UI.scanBtn.disabled = false;

    setState('準備完了');
    resizeCanvasToViewport();
    scheduleRender();
    logLine('準備完了。スクロール/クリックで操作できます。');
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


/** ===================== Band scan (5s slice WAV) ===================== */
let scanAbortCtrl = null;

function fmtHMS(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  const hh = String(h).padStart(2,'0');
  const mm = String(m).padStart(2,'0');
  const ss = String(s).padStart(2,'0');
  return `${hh}:${mm}:${ss}`;
}

function setScanProgress(pct){
  const v = clamp(pct, 0, 100);
  UI.scanPct.textContent = `${v.toFixed(0)}%`;
  UI.scanBar.style.width = `${v.toFixed(2)}%`;
}

function clearDetectList(){
  UI.detectList.innerHTML = '';
}

function addDetectButton(sec){
  const btn = document.createElement('button');
  btn.textContent = fmtHMS(sec);
  btn.className = 'mono';
  btn.addEventListener('click', async () => {
    if (!analyzer.inited) return;
    await playFrom(sec);
  });
  UI.detectList.appendChild(btn);
}

function wireScanSliders(){
  const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const syncAll = () => {
    let min = parseInt(UI.scanMinHz.value,10);
    let max = parseInt(UI.scanMaxHz.value,10);
    let thr = parseInt(UI.scanThreshold.value,10);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    if (!Number.isFinite(thr)) thr = 15;

    min = clampNum(min, 0, 24000);
    max = clampNum(max, 0, 24000);
    if (min > max) max = min;

    thr = clampNum(thr, 0, 40);

    UI.scanMinHz.value = String(min);
    UI.scanMaxHz.value = String(max);
    UI.scanThreshold.value = String(thr);

    // number inputs
    if (UI.scanMinHzVal) UI.scanMinHzVal.value = String(min);
    if (UI.scanMaxHzVal) UI.scanMaxHzVal.value = String(max);
    if (UI.scanThresholdVal) UI.scanThresholdVal.value = String(thr);
  };

  // range -> number
  UI.scanMinHz.addEventListener('input', syncAll);
  UI.scanMaxHz.addEventListener('input', syncAll);
  UI.scanThreshold.addEventListener('input', syncAll);

  // number -> range
  UI.scanMinHzVal?.addEventListener('input', () => {
    const v = parseInt(UI.scanMinHzVal.value,10);
    if (!Number.isFinite(v)) return;
    UI.scanMinHz.value = String(v);
    syncAll();
  });
  UI.scanMaxHzVal?.addEventListener('input', () => {
    const v = parseInt(UI.scanMaxHzVal.value,10);
    if (!Number.isFinite(v)) return;
    UI.scanMaxHz.value = String(v);
    syncAll();
  });
  UI.scanThresholdVal?.addEventListener('input', () => {
    const v = parseInt(UI.scanThresholdVal.value,10);
    if (!Number.isFinite(v)) return;
    UI.scanThreshold.value = String(v);
    syncAll();
  });

  // presets (delta dB)
  const setPreset = (min, max, thrDelta) => {
    UI.scanMinHz.value = String(min);
    UI.scanMaxHz.value = String(max);
    UI.scanThreshold.value = String(thrDelta);
    syncAll();
  };
  UI.presetNight?.addEventListener('click', () => setPreset(800, 4000, 10));
  UI.presetOwl?.addEventListener('click', () => setPreset(400, 1200, 12));
  UI.presetTora?.addEventListener('click', () => setPreset(2000, 2800, 15));

  syncAll();
}

async function readWavHeader(file){
  // Read first 256KB for safety (chunks may extend)
  const headBuf = await file.slice(0, Math.min(file.size, 262144)).arrayBuffer();
  const dv = new DataView(headBuf);
  const u8 = new Uint8Array(headBuf);

  const str = (off, len) => {
    let s = '';
    for (let i=0;i<len;i++) s += String.fromCharCode(u8[off+i]||0);
    return s;
  };

  if (str(0,4) !== 'RIFF' || str(8,4) !== 'WAVE') {
    throw new Error('WAV(RIFF/WAVE)ではありません');
  }

  let fmt = null;
  let data = null;

  let off = 12;
  while (off + 8 <= dv.byteLength) {
    const id = str(off,4);
    const size = dv.getUint32(off+4, true);
    const chunkDataOff = off + 8;
    if (id === 'fmt ') {
      if (chunkDataOff + 16 > dv.byteLength) break;
      const audioFormat = dv.getUint16(chunkDataOff+0, true); // 1=PCM, 3=float
      const numChannels = dv.getUint16(chunkDataOff+2, true);
      const sampleRate = dv.getUint32(chunkDataOff+4, true);
      const byteRate = dv.getUint32(chunkDataOff+8, true);
      const blockAlign = dv.getUint16(chunkDataOff+12, true);
      const bitsPerSample = dv.getUint16(chunkDataOff+14, true);
      fmt = { audioFormat, numChannels, sampleRate, byteRate, blockAlign, bitsPerSample };
    } else if (id === 'data') {
      data = { dataOffset: chunkDataOff, dataSize: size };
      break; // usually last; we can stop
    }
    off = chunkDataOff + size + (size % 2); // word aligned
  }

  if (!fmt || !data) throw new Error('WAVヘッダ解析に失敗（fmt/dataが見つかりません）');

  const bytesPerSample = fmt.bitsPerSample / 8;
  if (![1,3].includes(fmt.audioFormat)) throw new Error(`未対応WAV形式 audioFormat=${fmt.audioFormat}（PCM=1/Float=3のみ）`);
  if (![16, 32].includes(fmt.bitsPerSample)) throw new Error(`bitsPerSample=${fmt.bitsPerSample} 未対応（16/32のみ）`);
  if (!Number.isFinite(data.dataSize) || data.dataSize <= 0) throw new Error('dataSize不正');

  return {
    ...fmt,
    ...data,
    bytesPerSample,
    totalSamples: Math.floor(data.dataSize / fmt.blockAlign)
  };
}

function makeFft(fftSize){
  const N = fftSize;
  const rev = new Uint32Array(N);
  const logN = Math.log2(N);
  for (let i=0;i<N;i++){
    let x = i, y = 0;
    for (let b=0;b<logN;b++){ y = (y<<1) | (x & 1); x >>= 1; }
    rev[i]=y;
  }
  // twiddles per stage
  const cos = new Float32Array(N/2);
  const sin = new Float32Array(N/2);
  for (let k=0;k<N/2;k++){
    const ang = -2*Math.PI*k/N;
    cos[k]=Math.cos(ang);
    sin[k]=Math.sin(ang);
  }
  return {N, rev, cos, sin};
}

function fftInPlace(re, im, plan){
  const N = plan.N;
  const rev = plan.rev;
  for (let i=0;i<N;i++){
    const j = rev[i];
    if (j>i){
      let tr=re[i]; re[i]=re[j]; re[j]=tr;
      let ti=im[i]; im[i]=im[j]; im[j]=ti;
    }
  }
  for (let len=2; len<=N; len<<=1){
    const half = len>>1;
    const step = N/len;
    for (let i=0;i<N;i+=len){
      for (let j=0;j<half;j++){
        const k = j*step;
        const wr = plan.cos[k];
        const wi = plan.sin[k];
        const a = i+j;
        const b = a+half;
        const tr = wr*re[b] - wi*im[b];
        const ti = wr*im[b] + wi*re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] = re[a] + tr;
        im[a] = im[a] + ti;
      }
    }
  }
}

function hannWindow(n, N){
  return 0.5*(1 - Math.cos(2*Math.PI*n/(N-1)));
}

function decodePcmMono(buffer, header){
  const dv = new DataView(buffer);
  const {numChannels, bitsPerSample, audioFormat, bytesPerSample} = header;
  const frames = Math.floor(dv.byteLength / (numChannels*bytesPerSample));
  const mono = new Float32Array(frames);
  const isFloat = (audioFormat === 3 && bitsPerSample === 32);

  let off = 0;
  for (let i=0;i<frames;i++){
    let sum = 0;
    for (let ch=0; ch<numChannels; ch++){
      if (isFloat){
        sum += dv.getFloat32(off, true);
      } else {
        // 16-bit PCM
        sum += dv.getInt16(off, true) / 32768;
      }
      off += bytesPerSample;
    }
    mono[i] = sum / numChannels;
  }
  return mono;
}

async function scanBandWav(file){
  const SEG_SEC = 5;

  setState('スキャン中');
  UI.scanBtn.disabled = true;
  UI.scanAbortBtn.disabled = false;
  clearDetectList();
  setScanProgress(0);

  scanAbortCtrl = new AbortController();
  const sig = scanAbortCtrl.signal;

  const header = await readWavHeader(file);
  const bytesPerSec = header.sampleRate * header.blockAlign;
  const segBytes = Math.floor(bytesPerSec * SEG_SEC);
  const totalSeg = Math.ceil(header.dataSize / segBytes);

  const FFT_N = 2048;
  const plan = makeFft(FFT_N);
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);

  const minHz = clamp(parseInt(UI.scanMinHz.value,10)||0, 0, header.sampleRate/2);
  const maxHz = clamp(parseInt(UI.scanMaxHz.value,10)||0, 0, header.sampleRate/2);
  const thrDeltaDb = clamp(parseInt(UI.scanThreshold.value,10)||15, 0, 40);
  const lo = Math.min(minHz, maxHz);
  const hi = Math.max(minHz, maxHz);

  const binHz = header.sampleRate / FFT_N;
  const minBin = clamp(Math.floor(lo / binHz), 0, FFT_N/2);
  const maxBin = clamp(Math.ceil(hi / binHz), 0, FFT_N/2);

  // ---- noise learn (seconds range) ----
  let noiseFloorDb = -120;
  try{
    const ns = parseFloat(UI.noiseStartSec?.value ?? '5');
    const ne = parseFloat(UI.noiseEndSec?.value ?? '7');
    let startSec = Number.isFinite(ns) ? ns : 5;
    let endSec = Number.isFinite(ne) ? ne : 7;
    startSec = Math.max(0, startSec);
    endSec = Math.max(0, endSec);
    if (endSec < startSec) { const t=startSec; startSec=endSec; endSec=t; }
    if (endSec - startSec < 0.2) endSec = startSec + 0.2;

    const startByte = header.dataOffset + Math.floor(startSec * bytesPerSec);
    const endByte = Math.min(header.dataOffset + header.dataSize, header.dataOffset + Math.floor(endSec * bytesPerSec));
    const nab = await file.slice(startByte, endByte).arrayBuffer();
    const monoN = decodePcmMono(nab, header);

    const hopN = FFT_N >> 1;
    const bins = (maxBin - minBin + 1);
    const acc = new Float64Array(bins);
    let framesN = 0;

    for (let i=0; i + FFT_N <= monoN.length; i += hopN){
      for (let n=0;n<FFT_N;n++){
        re[n] = monoN[i+n] * hannWindow(n, FFT_N);
        im[n] = 0;
      }
      fftInPlace(re, im, plan);
      for (let b=minBin; b<=maxBin; b++){
        const rr = re[b], ii = im[b];
        acc[b-minBin] += rr*rr + ii*ii;
      }
      framesN++;
    }

    let noiseFloorPow = 0;
    if (framesN > 0){
      for (let k=0;k<bins;k++){
        const mean = acc[k] / framesN;
        if (mean > noiseFloorPow) noiseFloorPow = mean;
      }
      noiseFloorDb = 10 * Math.log10(noiseFloorPow + 1e-12);
    }
    logLine(`ノイズ学習: ${startSec.toFixed(1)}s〜${endSec.toFixed(1)}s / floor≈${noiseFloorDb.toFixed(1)} dB`);
  } catch(e){
    logLine(`ノイズ学習失敗（継続）: ${e?.message ?? e}`);
    noiseFloorDb = -120;
  }

  logLine(`スキャン開始: WAV ${header.sampleRate}Hz ch=${header.numChannels} bits=${header.bitsPerSample} / SEG=5s / FFT=${FFT_N}`);
  logLine(`帯域: ${lo}..${hi} Hz / 検出感度(差分): +${thrDeltaDb} dB`);
  logLine(`判定: 5秒内で1フレームでも (frameDb - noiseFloorDb) > +thr`);

  let lastDetectedBucket = -9999;

  for (let seg=0; seg<totalSeg; seg++){
    if (sig.aborted) throw new Error('スキャン中断');

    const startByte = seg * segBytes;
    const endByte = Math.min(header.dataSize, startByte + segBytes);
    const sliceStart = header.dataOffset + startByte;
    const sliceEnd = header.dataOffset + endByte;

    const ab = await file.slice(sliceStart, sliceEnd).arrayBuffer();
    const mono = decodePcmMono(ab, header);

    const hop = FFT_N >> 1;
    let detected = false;

    for (let i=0; i + FFT_N <= mono.length; i += hop){
      for (let n=0;n<FFT_N;n++){
        re[n] = mono[i+n] * hannWindow(n, FFT_N);
        im[n] = 0;
      }
      fftInPlace(re, im, plan);

      let frameMaxPow = 0;
      for (let b=minBin; b<=maxBin; b++){
        const rr = re[b], ii = im[b];
        const p = rr*rr + ii*ii;
        if (p > frameMaxPow) frameMaxPow = p;
      }
      const frameDb = 10 * Math.log10(frameMaxPow + 1e-12);
      if ((frameDb - noiseFloorDb) > thrDeltaDb){
        detected = true;
        break;
      }
      if (sig.aborted) break;
    }

    setScanProgress(((seg+1)/totalSeg)*100);

    if (detected){
      const bucket = seg;
      if (bucket !== lastDetectedBucket){
        lastDetectedBucket = bucket;
        addDetectButton(bucket * SEG_SEC);
      }
    }

    await sleep(0);
  }
}

async function scanBandDecode(file){
  // MP3/AAC/OGG等: slice → decodeAudioData → FFT判定
  const SEG_SEC = 5;
  const OVERLAP_SEC = 0.25;

  setState('スキャン中');
  UI.scanBtn.disabled = true;
  UI.scanAbortBtn.disabled = false;
  clearDetectList();
  setScanProgress(0);

  scanAbortCtrl = new AbortController();
  const sig = scanAbortCtrl.signal;

  const duration = analyzer.duration || await ensureFullAudioMetadata(file);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration取得に失敗');

  const totalSeg = Math.ceil(duration / SEG_SEC);

  const bytesPerSecEst = file.size / duration;
  const segBytes = Math.max(256*1024, Math.floor(bytesPerSecEst * SEG_SEC));
  const overlapBytes = Math.floor(bytesPerSecEst * OVERLAP_SEC);

  const FFT_N = 2048;
  const plan = makeFft(FFT_N);
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);

  const minHz = clamp(parseInt(UI.scanMinHz.value,10)||0, 0, 24000);
  const maxHz = clamp(parseInt(UI.scanMaxHz.value,10)||0, 0, 24000);
  const thrDeltaDb = clamp(parseInt(UI.scanThreshold.value,10)||15, 0, 40);
  const lo = Math.min(minHz, maxHz);
  const hi = Math.max(minHz, maxHz);

  if (!analyzer.audioCtx) analyzer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioCtx = analyzer.audioCtx;
  if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }

  // ---- noise learn (decode) ----
  let noiseFloorDb = -120;
  try{
    const ns = parseFloat(UI.noiseStartSec?.value ?? '5');
    const ne = parseFloat(UI.noiseEndSec?.value ?? '7');
    let startSec = Number.isFinite(ns) ? ns : 5;
    let endSec = Number.isFinite(ne) ? ne : 7;
    startSec = Math.max(0, startSec);
    endSec = Math.max(0, endSec);
    if (endSec < startSec) { const t=startSec; startSec=endSec; endSec=t; }
    if (endSec - startSec < 0.2) endSec = startSec + 0.2;

    const startByte = Math.max(0, Math.floor(startSec * bytesPerSecEst) - overlapBytes);
    const endByte = Math.min(file.size, Math.floor(endSec * bytesPerSecEst) + overlapBytes);
    const nab = await file.slice(startByte, endByte).arrayBuffer();
    const nbuf = await audioCtx.decodeAudioData(nab);
    const sr = nbuf.sampleRate;
    const monoN = nbuf.getChannelData(0);

    const binHz = sr / FFT_N;
    const minBin = clamp(Math.floor(lo / binHz), 0, FFT_N/2);
    const maxBin = clamp(Math.ceil(hi / binHz), 0, FFT_N/2);

    const hopN = FFT_N >> 1;
    const bins = (maxBin - minBin + 1);
    const acc = new Float64Array(bins);
    let framesN = 0;

    for (let i=0; i + FFT_N <= monoN.length; i += hopN){
      for (let n=0;n<FFT_N;n++){
        re[n] = monoN[i+n] * hannWindow(n, FFT_N);
        im[n] = 0;
      }
      fftInPlace(re, im, plan);
      for (let b=minBin; b<=maxBin; b++){
        const rr = re[b], ii = im[b];
        acc[b-minBin] += rr*rr + ii*ii;
      }
      framesN++;
    }

    let noiseFloorPow = 0;
    if (framesN > 0){
      for (let k=0;k<bins;k++){
        const mean = acc[k] / framesN;
        if (mean > noiseFloorPow) noiseFloorPow = mean;
      }
      noiseFloorDb = 10 * Math.log10(noiseFloorPow + 1e-12);
    }
    logLine(`ノイズ学習: ${startSec.toFixed(1)}s〜${endSec.toFixed(1)}s / floor≈${noiseFloorDb.toFixed(1)} dB`);
  } catch(e){
    console.warn('ノイズ学習失敗（継続）', e);
    logLine(`ノイズ学習失敗（継続）: ${e?.message ?? e}`);
    noiseFloorDb = -120;
  }

  logLine(`スキャン開始: decode方式 / duration≈${duration.toFixed(2)}s / SEG=5s / FFT=${FFT_N}`);
  logLine(`帯域: ${lo}..${hi} Hz / 検出感度(差分): +${thrDeltaDb} dB`);
  logLine(`判定: 5秒内で1フレームでも (frameDb - noiseFloorDb) > +thr`);

  let lastDetectedBucket = -9999;

  for (let seg=0; seg<totalSeg; seg++){
    if (sig.aborted) throw new Error('スキャン中断');

    const segStartSec = seg * SEG_SEC;
    const startByte = Math.max(0, Math.floor(segStartSec * bytesPerSecEst) - overlapBytes);
    const endByte = Math.min(file.size, startByte + segBytes + overlapBytes);

    let arrayBuf = null;

    try{
      arrayBuf = await file.slice(startByte, endByte).arrayBuffer();
      const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
      const sr = audioBuf.sampleRate;
      const mono = audioBuf.getChannelData(0);

      const binHz = sr / FFT_N;
      const minBin = clamp(Math.floor(lo / binHz), 0, FFT_N/2);
      const maxBin = clamp(Math.ceil(hi / binHz), 0, FFT_N/2);

      const hop = FFT_N >> 1;
      let detected = false;

      for (let i=0; i + FFT_N <= mono.length; i += hop){
        for (let n=0;n<FFT_N;n++){
          re[n] = mono[i+n] * hannWindow(n, FFT_N);
          im[n] = 0;
        }
        fftInPlace(re, im, plan);

        let frameMaxPow = 0;
        for (let b=minBin; b<=maxBin; b++){
          const rr = re[b], ii = im[b];
          const p = rr*rr + ii*ii;
          if (p > frameMaxPow) frameMaxPow = p;
        }
        const frameDb = 10 * Math.log10(frameMaxPow + 1e-12);
        if ((frameDb - noiseFloorDb) > thrDeltaDb){
          detected = true;
          break;
        }
        if (sig.aborted) break;
      }

      if (detected){
        const bucket = seg;
        if (bucket !== lastDetectedBucket){
          lastDetectedBucket = bucket;
          addDetectButton(bucket * SEG_SEC);
        }
      }
    } catch(e){
      console.warn('デコード失敗、スキップします', e);
      logLine(`seg#${seg} decode失敗（skip）: ${e?.message ?? e}`);
    } finally {
      arrayBuf = null;
    }

    setScanProgress(((seg+1)/totalSeg)*100);
    await sleep(0);
  }
}

async function scanBand(file){
  try{
    // WAV header check; if fails, fall back to decode方式（MP3等）
    try{
      await readWavHeader(file);
      await scanBand(file);
    } catch(e){
      await scanBandDecode(file);
    }
  } finally {
    UI.scanBtn.disabled = false;
    UI.scanAbortBtn.disabled = true;
    scanAbortCtrl = null;
    setState('準備完了');
    setScanProgress(0);
  }
}

UI.scanBtn.addEventListener('click', async () => {
  const file = UI.fileInput.files?.[0];
  if (!file) { alert('音声ファイルを選択してください'); return; }

  try {
    await scanBand(file);
  } catch (e) {
    const msg = e?.message ?? String(e);
    logLine(`スキャン停止: ${msg}`);
    setState('準備完了');
  } finally {
    UI.scanBtn.disabled = false;
    UI.scanAbortBtn.disabled = true;
    scanAbortCtrl = null;
    setScanProgress(0);
  }
});

UI.scanAbortBtn.addEventListener('click', () => {
  if (scanAbortCtrl) scanAbortCtrl.abort();
});

wireScanSliders();

clearAll();
