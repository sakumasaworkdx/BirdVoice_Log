'use strict';

/**
 * v2.5.3
 * - 読み込み/準備が反応しない原因のほとんどは「index.html と script.js の不一致」です。
 *   このスクリプトは、要素が無い場合でも落ちないようにガードしてあります。
 */

window.addEventListener('error', (e) => {
  try {
    const el = document.getElementById('log');
    if (!el) return;
    const msg = e?.message || 'unknown';
    const src = e?.filename ? ` @ ${e.filename}:${e.lineno}` : '';
    el.textContent += `[JS ERROR] ${msg}${src}\n`;
  } catch {}
});

const AXIS_W = 64;
const PAD_T = 8;
const PAD_B = 16;
const TILE_H = 512;

const PREFETCH_TILES = 2;
const SCROLL_IDLE_MS = 140;
const PREVIEW_FPS_MAX = 20;

const FEATURE_BANDS = 48;

const UI = {
  fileInput: document.getElementById('fileInput'),
  prepareBtn: document.getElementById('prepareBtn'),
  diagBtn: document.getElementById('diagBtn'),
  playBtn: document.getElementById('playBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn'),

  tileSec: document.getElementById('tileSec'),
  fps: document.getElementById('fps'),
  fftSize: document.getElementById('fftSize'),
  maxHz: document.getElementById('maxHz'),
  minDb: document.getElementById('minDb'),
  maxDb: document.getElementById('maxDb'),
  cmap: document.getElementById('cmap'),
  freqScale: document.getElementById('freqScale'),
  pxPerSec: document.getElementById('pxPerSec'),
  cacheTiles: document.getElementById('cacheTiles'),
  hlMinHz: document.getElementById('hlMinHz'),
  hlMaxHz: document.getElementById('hlMaxHz'),

  exportStartSec: document.getElementById('exportStartSec'),
  exportEndSec: document.getElementById('exportEndSec'),
  exportViewBtn: document.getElementById('exportViewBtn'),
  exportRangeBtn: document.getElementById('exportRangeBtn'),

  state: document.getElementById('state'),
  meta: document.getElementById('meta'),
  tileInfo: document.getElementById('tileInfo'),
  viewportInfo: document.getElementById('viewportInfo'),
  progFill: document.getElementById('progFill'),
  log: document.getElementById('log'),

  viewport: document.getElementById('viewport'),
  specCanvas: document.getElementById('specCanvas'),
  fullAudio: document.getElementById('fullAudio'),

  // scan
  scanMinHz: document.getElementById('scanMinHz'),
  scanMaxHz: document.getElementById('scanMaxHz'),
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

function logLine(s){
  if (!UI.log) return;
  UI.log.textContent += s + "\n";
  UI.log.scrollTop = UI.log.scrollHeight;
}

function setState(s){
  if (UI.state) UI.state.textContent = s;
}

function nowMs(){ return performance.now(); }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function seekAndWait(audio, t, timeoutMs=700){
  return new Promise((resolve) => {
    let done = false;
    const onSeeked = () => { if (done) return; done = true; cleanup(); resolve(true); };
    const onErr = () => { if (done) return; done = true; cleanup(); resolve(false); };
    const timer = setTimeout(() => { if (done) return; done = true; cleanup(); resolve(false); }, timeoutMs);
    function cleanup(){ clearTimeout(timer); audio.removeEventListener('seeked', onSeeked); audio.removeEventListener('error', onErr); }
    audio.addEventListener('seeked', onSeeked, { once:true });
    audio.addEventListener('error', onErr, { once:true });
    try{ audio.currentTime = t; } catch { cleanup(); resolve(false); }
  });
}

function secToHMS(sec){
  sec = Math.max(0, sec);
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = Math.floor(sec%60);
  const ms = Math.floor((sec - Math.floor(sec))*1000);
  if (h>0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}

function downloadBlob(blob, filename){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function getConfig(){
  const tileSec = clamp(parseFloat(UI.tileSec?.value) || 5, 2, 20);
  const fps = clamp(parseFloat(UI.fps?.value) || 30, 5, 120);
  const fftSize = parseInt(UI.fftSize?.value || '2048', 10);
  const maxHz = clamp(parseFloat(UI.maxHz?.value) || 12000, 1000, 24000);
  const minDb = clamp(parseFloat(UI.minDb?.value) || -100, -120, -10);
  const maxDb = clamp(parseFloat(UI.maxDb?.value) || -20, -80, 0);
  const cmap = UI.cmap?.value || 'Grayscale';
  const freqScale = UI.freqScale?.value || 'log';
  const pxPerSec = clamp(parseFloat(UI.pxPerSec?.value) || 120, 30, 400);
  const cacheTiles = clamp(parseInt(UI.cacheTiles?.value || '120', 10), 10, 400);
  const hlMinHz = clamp(parseFloat(UI.hlMinHz?.value) || 2500, 0, 24000);
  const hlMaxHz = clamp(parseFloat(UI.hlMaxHz?.value) || 9000, 0, 24000);
  return {
    tileSec, fps, fftSize, maxHz, minDb, maxDb, cmap, freqScale, pxPerSec, cacheTiles,
    hlMinHz: Math.min(hlMinHz, hlMaxHz),
    hlMaxHz: Math.max(hlMinHz, hlMaxHz),
    minHz: 50,
  };
}
function getPreviewConfig(cfg){
  const fpsPreview = Math.min(cfg.fps, PREVIEW_FPS_MAX);
  if (fpsPreview === cfg.fps) return cfg;
  return { ...cfg, fps: fpsPreview };
}

/** ====== Analyser runtime ====== */
const analyzer = {
  inited: false,
  duration: 0,
  file: null,
  url: null,

  audio: null,
  audioCtx: null,
  analyser: null,
  srcNode: null,
  gain0: null,

  analysisPlaying: false, // muted analysis loop
};

function clearAll(){
  // stop
  try { if (analyzer.audio) analyzer.audio.pause(); } catch {}
  analyzer.analysisPlaying = false;

  // disconnect audio graph
  try { analyzer.srcNode?.disconnect(); } catch {}
  try { analyzer.srcNode?.disconnect(); } catch {}
  try { analyzer.analyser?.disconnect(); } catch {}
  try { analyzer.gain0?.disconnect(); } catch {}
  try { analyzer.audioCtx?.close(); } catch {}

  analyzer.inited = false;
  analyzer.duration = 0;

  if (analyzer.url) { try { URL.revokeObjectURL(analyzer.url); } catch {} }
  analyzer.url = null;
  analyzer.file = null;

  tileCache.clear();
  lruOrder.length = 0;
  tileInFlight.clear();
  abortCtrl?.abort();
  abortCtrl = null;

  scanHits = [];
  updateDetectList();
  if (UI.scanBarFill) UI.scanBarFill.style.width = '0%';
  if (UI.scanStatus) UI.scanStatus.textContent = 'scan: -';

  if (UI.meta) UI.meta.textContent = '-';
  if (UI.tileInfo) UI.tileInfo.textContent = 'tile: -';
  if (UI.viewportInfo) UI.viewportInfo.textContent = 'view: -';
  if (UI.progFill) UI.progFill.style.width = '0%';

  if (UI.playBtn) UI.playBtn.disabled = true;
  if (UI.pauseBtn) UI.pauseBtn.disabled = true;
  if (UI.stopBtn) UI.stopBtn.disabled = true;
  if (UI.exportViewBtn) UI.exportViewBtn.disabled = true;
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = true;
  if (UI.scanBtn) UI.scanBtn.disabled = true;
  if (UI.scanStopBtn) UI.scanStopBtn.disabled = true;

  if (UI.fullAudio) { UI.fullAudio.src = ''; UI.fullAudio.load(); }

  setState('未準備');
  logLine('reset.');
  scheduleRender();
}

/** ====== Tile cache ====== */
const tileCache = new Map(); // key -> tile {bitmap,width,height,tileIndex, tileStart, featEdges, featCols, lastUsed}
const tileInFlight = new Set();
const lruOrder = []; // keys, oldest first

function makeTileKey(ti, cfg){
  return `ti:${ti}|sec:${cfg.tileSec}|fps:${cfg.fps}|fft:${cfg.fftSize}|max:${cfg.maxHz}|db:${cfg.minDb},${cfg.maxDb}|cmap:${cfg.cmap}|scale:${cfg.freqScale}`;
}
function lruTouch(key){
  const idx = lruOrder.indexOf(key);
  if (idx >= 0) lruOrder.splice(idx,1);
  lruOrder.push(key);
}
function lruPrune(maxTiles){
  while (lruOrder.length > maxTiles){
    const key = lruOrder.shift();
    const t = tileCache.get(key);
    if (t?.bitmap) { try { t.bitmap.close?.(); } catch {} }
    tileCache.delete(key);
  }
}

/** ====== Feature bands (for fast scan reuse) ====== */
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
  const sr = analyzer.audioCtx.sampleRate;
  const binHz = sr / cfg.fftSize;
  const bins = tmpDb.length;
  const out = new Uint16Array(FEATURE_BANDS);
  for (let bi=0; bi<FEATURE_BANDS; bi++){
    const loHz = edges[bi], hiHz = edges[bi+1];
    const lo = clamp(Math.floor(loHz / binHz), 0, bins-1);
    const hi = clamp(Math.ceil(hiHz / binHz), 0, bins-1);
    if (hi <= lo){ out[bi] = 0; continue; }
    let sumP = 0, n = 0;
    for (let i=lo;i<=hi;i++){
      const db = tmpDb[i];
      const p = Math.pow(10, (Math.max(-120, db) / 10));
      sumP += p; n++;
    }
    const meanP = sumP / Math.max(1, n);
    const meanDb = 10 * Math.log10(Math.max(1e-12, meanP));
    out[bi] = clamp(Math.round((meanDb * 100) + 12000), 0, 65535);
  }
  return out;
}
function featureBandsToMeanDb(featureBands, edges, minHz, maxHz){
  let sumP = 0;
  let n = 0;
  for (let bi=0; bi<FEATURE_BANDS; bi++){
    const loHz = edges[bi], hiHz = edges[bi+1];
    if (hiHz <= minHz || loHz >= maxHz) continue;
    const db = (featureBands[bi] - 12000) / 100;
    const p = Math.pow(10, db / 10);
    sumP += p;
    n++;
  }
  if (n <= 0) return -120;
  return 10 * Math.log10(Math.max(1e-12, sumP));
}
function featureBandsPeakDb(featureBands, edges, minHz, maxHz){
  let best = -120;
  for (let bi=0; bi<FEATURE_BANDS; bi++){
    const loHz = edges[bi], hiHz = edges[bi+1];
    if (hiHz <= minHz || loHz >= maxHz) continue;
    const db = (featureBands[bi] - 12000) / 100;
    if (db > best) best = db;
  }
  return best;
}

/** ====== Color maps ====== */
// return rgb [0..255]
function lerp(a,b,t){ return a + (b-a)*t; }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function turbo(t){
  // simple poly approx (not exact, but good enough)
  t = clamp01(t);
  const r = clamp01(0.13572138 + 4.61539260*t - 42.66032258*t*t + 132.13108234*t**3 - 152.94239396*t**4 + 59.28637943*t**5);
  const g = clamp01(0.09140261 + 2.19418839*t + 4.84296658*t*t - 14.18503333*t**3 + 4.27729857*t**4 + 2.82956604*t**5);
  const b = clamp01(0.10667330 + 11.60249360*t - 87.92710760*t*t + 291.37340000*t**3 - 376.47366000*t**4 + 156.75412000*t**5);
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}
function magma(t){
  t = clamp01(t);
  // rough gradient stops
  const stops = [
    [0.0, [0,0,4]],
    [0.25,[59,15,112]],
    [0.5, [180,54,121]],
    [0.75,[251,140,60]],
    [1.0, [252,253,191]]
  ];
  for (let i=0;i<stops.length-1;i++){
    const [t0,c0]=stops[i], [t1,c1]=stops[i+1];
    if (t>=t0 && t<=t1){
      const u=(t-t0)/(t1-t0);
      return [Math.round(lerp(c0[0],c1[0],u)), Math.round(lerp(c0[1],c1[1],u)), Math.round(lerp(c0[2],c1[2],u))];
    }
  }
  return stops[stops.length-1][1];
}
function viridis(t){
  t = clamp01(t);
  const stops = [
    [0.0,[68,1,84]],
    [0.25,[59,82,139]],
    [0.5,[33,145,140]],
    [0.75,[94,201,97]],
    [1.0,[253,231,37]]
  ];
  for (let i=0;i<stops.length-1;i++){
    const [t0,c0]=stops[i], [t1,c1]=stops[i+1];
    if (t>=t0 && t<=t1){
      const u=(t-t0)/(t1-t0);
      return [Math.round(lerp(c0[0],c1[0],u)), Math.round(lerp(c0[1],c1[1],u)), Math.round(lerp(c0[2],c1[2],u))];
    }
  }
  return stops[stops.length-1][1];
}
function grayscale(t){
  t = clamp01(t);
  const v = Math.round(t*255);
  return [v,v,v];
}
function mapColor(name, t){
  switch(name){
    case 'Turbo': return turbo(t);
    case 'Magma': return magma(t);
    case 'Viridis': return viridis(t);
    default: return grayscale(t);
  }
}

/** ====== Tile generation ====== */
let abortCtrl = null;

async function ensureAudioGraph(){
  if (analyzer.audioCtx) return;

  analyzer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyzer.analyser = analyzer.audioCtx.createAnalyser();
  analyzer.analyser.smoothingTimeConstant = 0;
  analyzer.analyser.minDecibels = -120;
  analyzer.analyser.maxDecibels = 0;

  analyzer.audio = new Audio();
  analyzer.audio.preload = 'auto';
  analyzer.audio.crossOrigin = 'anonymous';
  analyzer.audio.loop = true; // analysis seeks are easier
  analyzer.audio.playsInline = true;
  analyzer.audio.muted = true;
  analyzer.audio.volume = 0;

  analyzer.srcNode = analyzer.audioCtx.createMediaElementSource(analyzer.audio);
  analyzer.gain0 = analyzer.audioCtx.createGain();
  analyzer.gain0.gain.value = 0;
  analyzer.srcNode.connect(analyzer.analyser);
  analyzer.analyser.connect(analyzer.gain0);
  analyzer.gain0.connect(analyzer.audioCtx.destination);
}

async function prepare(){
  const file = UI.fileInput?.files?.[0];
  if (!file){
    logLine('ファイルを選択してください');
    return;
  }

  clearAll();
  setState('準備中');

  analyzer.file = file;
  analyzer.url = URL.createObjectURL(file);

  await ensureAudioGraph();
  analyzer.audio.src = analyzer.url;

  // user playback uses fullAudio (separate element) for audible play
  if (UI.fullAudio){
    UI.fullAudio.src = analyzer.url;
    UI.fullAudio.load();
  }

  // wait metadata
  await new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const onNg = (e) => { cleanup(); reject(new Error('metadata load failed')); };
    const cleanup = () => {
      analyzer.audio.removeEventListener('loadedmetadata', onOk);
      analyzer.audio.removeEventListener('error', onNg);
    };
    analyzer.audio.addEventListener('loadedmetadata', onOk);
    analyzer.audio.addEventListener('error', onNg);
    analyzer.audio.load();
  });

  analyzer.duration = analyzer.audio.duration || 0;
  analyzer.inited = true;

  // start muted analysis playback once (gesture already happened)
  try{
    if (analyzer.audioCtx.state === 'suspended') await analyzer.audioCtx.resume();
    analyzer.audio.muted = true;
    analyzer.audio.volume = 0;
    await analyzer.audio.play();
    analyzer.analysisPlaying = true;
  } catch (e){
    analyzer.analysisPlaying = false;
    logLine('分析用の再生開始に失敗（後で再試行します）');
  }

  // canvas sizing
  resizeCanvas();

  if (UI.playBtn) UI.playBtn.disabled = false;
  if (UI.pauseBtn) UI.pauseBtn.disabled = false;
  if (UI.stopBtn) UI.stopBtn.disabled = false;
  if (UI.exportViewBtn) UI.exportViewBtn.disabled = false;
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = false;
  if (UI.scanBtn) UI.scanBtn.disabled = false;

  if (UI.meta){
    UI.meta.textContent = `${file.name} / ${(file.size/1024/1024).toFixed(1)}MB / ${secToHMS(analyzer.duration)}`;
  }

  setState('準備完了');
  logLine('準備完了。スクロールで表示、停止後にタイル解析します。');

  scheduleRender();
}

function freqToY(cfg, hz, plotH){
  const maxHz = cfg.maxHz;
  hz = clamp(hz, 0, maxHz);
  if (cfg.freqScale === 'log'){
    const lo = 50;
    const a = Math.log(lo);
    const b = Math.log(maxHz);
    const x = (Math.log(Math.max(lo, hz)) - a) / (b-a);
    return plotH - x * plotH;
  } else {
    const x = hz / maxHz;
    return plotH - x * plotH;
  }
}

function yToFreq(cfg, y, plotH){
  const maxHz = cfg.maxHz;
  const t = 1 - (y / plotH);
  if (cfg.freqScale === 'log'){
    const lo = 50;
    const a = Math.log(lo);
    const b = Math.log(maxHz);
    const hz = Math.exp(a + (b-a)*t);
    return hz;
  }
  return t * maxHz;
}

async function generateTileBitmap(tileIndex, cfg, signal){
  const tileStart = tileIndex * cfg.tileSec;
  const width = Math.max(1, Math.floor(cfg.tileSec * cfg.fps));
  const height = TILE_H;

  analyzer.analyser.fftSize = cfg.fftSize;
  analyzer.analyser.minDecibels = cfg.minDb;
  analyzer.analyser.maxDecibels = cfg.maxDb;

  const bins = analyzer.analyser.frequencyBinCount;
  const tmp = new Float32Array(bins);
  const featEdges = buildFeatureBands(cfg);
  const featCols = new Array(width);

  const oc = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(width, height)
    : (() => { const c=document.createElement('canvas'); c.width=width; c.height=height; return c; })();
  const ctx = oc.getContext('2d', { willReadFrequently: true });

  const img = ctx.createImageData(width, height);
  const data = img.data;

  // seek (wait for seeked; ensure analysis audio is actually playing)
  const startT = clamp(tileStart, 0, Math.max(0, analyzer.duration - 0.001));
  await seekAndWait(analyzer.audio, startT);
  if (analyzer.audio.paused){ try{ await analyzer.audio.play(); analyzer.analysisPlaying = true; } catch {} }

  // fill columns
  for (let x=0; x<width; x++){
    if (signal?.aborted) throw new Error('aborted');
    const t = tileStart + (x / cfg.fps);
    if (t >= analyzer.duration) break;

    await seekAndWait(analyzer.audio, clamp(t, 0, Math.max(0, analyzer.duration-0.001)), 450);
    if (analyzer.audio.paused){ try{ await analyzer.audio.play(); analyzer.analysisPlaying = true; } catch {} }

    analyzer.analyser.getFloatFrequencyData(tmp);
    featCols[x] = spectrumToFeatureBands(tmp, cfg, featEdges);

    for (let y=0; y<height; y++){
      const hz = yToFreq(cfg, y, height);
      const binHz = analyzer.audioCtx.sampleRate / cfg.fftSize;
      const bi = clamp(Math.round(hz / binHz), 0, bins-1);
      let db = tmp[bi];
      if (!Number.isFinite(db)) db = cfg.minDb; // -Infinity 対策
      const v = (db - cfg.minDb) / (cfg.maxDb - cfg.minDb);
      const tcol = clamp01(v);
      const rgb = mapColor(cfg.cmap, tcol);
      const off = (y*width + x) * 4;
      data[off+0] = rgb[0];
      data[off+1] = rgb[1];
      data[off+2] = rgb[2];
      data[off+3] = 255;
    }
  }

  // extend last column to the end to avoid blank
  for (let x=1; x<width; x++){
    if (!featCols[x]) featCols[x] = featCols[x-1];
  }

  ctx.putImageData(img, 0, 0);
  const bitmap = await createImageBitmap(oc);
  return { bitmap, width, height, tileIndex, tileStart, tileSec: cfg.tileSec, lastUsed: nowMs(), featEdges, featCols };
}

/** ====== Rendering ====== */
let renderQueued = false;

function resizeCanvas(){
  if (!UI.viewport || !UI.specCanvas) return;
  const rect = UI.viewport.getBoundingClientRect();
  UI.specCanvas.width = Math.max(800, Math.floor(rect.width));
  UI.specCanvas.height = Math.max(300, Math.floor(rect.height));
}

function getViewportRange(cfg){
  const vw = UI.specCanvas.width - AXIS_W;
  const startSec = (UI.viewport.scrollLeft / cfg.pxPerSec);
  const endSec = startSec + Math.max(0.1, vw / cfg.pxPerSec);
  return { startSec, endSec };
}

function scheduleRender(){
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderViewport();
  });
}

async function ensureTilesForRange(cfg, range){
  if (!analyzer.inited) return;
  const startIdx0 = Math.floor(range.startSec / cfg.tileSec);
  const endIdx0 = Math.floor(range.endSec / cfg.tileSec);

  const startIdx = Math.max(0, startIdx0 - PREFETCH_TILES);
  const endIdx = Math.min(Math.floor(analyzer.duration / cfg.tileSec), endIdx0 + PREFETCH_TILES);

  if (UI.tileInfo){
    UI.tileInfo.textContent = `tile: view ${startIdx0}-${endIdx0} / prefetch ${startIdx}-${endIdx} / cache ${tileCache.size}`;
  }
  lruPrune(cfg.cacheTiles);

  const cfgPrev = getPreviewConfig(cfg);

  // priority: view preview -> view full -> prefetch preview -> prefetch full
  const want = [];
  for (let ti=startIdx0; ti<=endIdx0; ti++) want.push({ti, cfg: cfgPrev});
  for (let ti=startIdx0; ti<=endIdx0; ti++) want.push({ti, cfg: cfg});
  for (let ti=startIdx; ti<=endIdx; ti++) want.push({ti, cfg: cfgPrev});
  for (let ti=startIdx; ti<=endIdx; ti++) want.push({ti, cfg: cfg});

  for (const w of want){
    if (abortCtrl?.signal?.aborted) return;
    const key = makeTileKey(w.ti, w.cfg);
    if (tileCache.has(key)) { lruTouch(key); continue; }
    if (tileInFlight.has(key)) continue;
    if (tileInFlight.size >= 1) return;

    tileInFlight.add(key);
    (async ()=>{
      try{
        logLine(`tile#${w.ti} gen start (fps=${w.cfg.fps})`);
        const tile = await generateTileBitmap(w.ti, w.cfg, abortCtrl?.signal);
        tileCache.set(key, tile);
        lruTouch(key);
        logLine(`tile#${w.ti} gen ok`);
      } catch(e){
        logLine(`tile#${w.ti} gen fail: ${e?.message ?? e}`);
      } finally {
        tileInFlight.delete(key);
        scheduleRender();
      }
    })();
    return;
  }
}

function drawAxis(ctx, cfg, plotH, cw, ch){
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,AXIS_W,ch);

  ctx.strokeStyle = 'rgba(0,0,0,.12)';
  ctx.beginPath();
  ctx.moveTo(AXIS_W+0.5,0);
  ctx.lineTo(AXIS_W+0.5,ch);
  ctx.stroke();

  ctx.fillStyle = '#111827';
  ctx.font = '12px ' + (getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace');

  // kHz ticks
  const ticks = [1,2,3,4,6,8,10,12,14,16,18,20,24].map(k=>k*1000).filter(hz=>hz<=cfg.maxHz);
  for (const hz of ticks){
    const y = PAD_T + freqToY(cfg, hz, plotH);
    ctx.strokeStyle = 'rgba(0,0,0,.10)';
    ctx.beginPath();
    ctx.moveTo(0,y+0.5);
    ctx.lineTo(AXIS_W,y+0.5);
    ctx.stroke();
    const txt = (hz/1000).toFixed(0) + 'k';
    ctx.fillText(txt, 8, y+4);
  }
  ctx.restore();
}

function drawTimeTopGrid(ctx, cfg, startSec, endSec, cw, ch){
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.fillStyle = 'rgba(255,255,255,.16)';
  ctx.font = '12px ' + (getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace');
  const span = endSec - startSec;
  const step = span > 120 ? 10 : span > 60 ? 5 : span > 20 ? 2 : 1;
  for (let s=Math.floor(startSec/step)*step; s<=endSec; s+=step){
    const x = AXIS_W + (s-startSec)*cfg.pxPerSec;
    ctx.beginPath();
    ctx.moveTo(x+0.5, 0);
    ctx.lineTo(x+0.5, ch);
    ctx.stroke();
    ctx.fillText(secToHMS(s), x+4, 14);
  }
  ctx.restore();
}

function drawBandHighlight(ctx, cfg, plotH, cw){
  ctx.save();
  const y0 = PAD_T + freqToY(cfg, cfg.hlMaxHz, plotH);
  const y1 = PAD_T + freqToY(cfg, cfg.hlMinHz, plotH);
  ctx.fillStyle = 'rgba(94,234,212,.08)';
  ctx.fillRect(AXIS_W, y0, cw-AXIS_W, Math.max(1, y1-y0));
  ctx.restore();
}

function drawPlayhead(ctx, cfg, viewStartSec, t, cw, ch){
  const x = AXIS_W + (t - viewStartSec) * cfg.pxPerSec;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,80,80,.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x+0.5, 0);
  ctx.lineTo(x+0.5, ch);
  ctx.stroke();
  ctx.restore();
}

function drawDetectionsOverlay(ctx, cfg, viewStartSec, viewEndSec, cw, ch){
  if (!scanHits || scanHits.length === 0) return;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 80, 80, 0.10)';
  ctx.strokeStyle = 'rgba(255, 80, 80, 0.55)';
  ctx.lineWidth = 1;

  for (const h of scanHits){
    if (h.end < viewStartSec || h.start > viewEndSec) continue;
    const x0 = AXIS_W + (Math.max(h.start, viewStartSec) - viewStartSec) * cfg.pxPerSec;
    const x1 = AXIS_W + (Math.min(h.end, viewEndSec) - viewStartSec) * cfg.pxPerSec;
    ctx.fillRect(x0, 0, Math.max(1, x1-x0), ch);
    const xp = AXIS_W + (clamp(h.peakTime, viewStartSec, viewEndSec) - viewStartSec) * cfg.pxPerSec;
    ctx.beginPath();
    ctx.moveTo(xp+0.5, 0);
    ctx.lineTo(xp+0.5, ch);
    ctx.stroke();
  }
  ctx.restore();
}

function renderViewport(){
  if (!UI.specCanvas || !UI.viewport) return;
  const ctx = UI.specCanvas.getContext('2d', { alpha:false });

  const cfg = getConfig();
  const range = getViewportRange(cfg);
  const cw = UI.specCanvas.width;
  const ch = UI.specCanvas.height;
  const plotH = ch - PAD_T - PAD_B;

  // background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,cw,ch);

  drawAxis(ctx, cfg, plotH, cw, ch);
  drawTimeTopGrid(ctx, cfg, range.startSec, range.endSec, cw, ch);
  drawBandHighlight(ctx, cfg, plotH, cw);

  // tiles
  const startIdx = Math.floor(range.startSec / cfg.tileSec);
  const endIdx = Math.floor(range.endSec / cfg.tileSec);

  for (let ti=startIdx; ti<=endIdx; ti++){
    const keyFull = makeTileKey(ti, cfg);
    let tile = tileCache.get(keyFull);
    if (!tile){
      const cfgPrev = getPreviewConfig(cfg);
      const keyPrev = makeTileKey(ti, cfgPrev);
      tile = tileCache.get(keyPrev);
    }
    if (!tile) continue;

    const tileStart = ti * cfg.tileSec;
    const tileEnd = tileStart + cfg.tileSec;
    const drawStart = Math.max(range.startSec, tileStart);
    const drawEnd = Math.min(range.endSec, tileEnd);
    if (drawEnd <= drawStart) continue;

    const srcX0 = (drawStart - tileStart) * cfg.fps;
    const srcX1 = (drawEnd - tileStart) * cfg.fps;
    const srcW = Math.max(1, srcX1 - srcX0);

    const dstX0 = AXIS_W + (drawStart - range.startSec) * cfg.pxPerSec;
    const dstW = (drawEnd - drawStart) * cfg.pxPerSec;

    ctx.drawImage(tile.bitmap, srcX0, 0, srcW, tile.height, dstX0, PAD_T, dstW, plotH);
  }

  drawDetectionsOverlay(ctx, cfg, range.startSec, range.endSec, cw, ch);

  const t = UI.fullAudio?.currentTime || 0;
  drawPlayhead(ctx, cfg, range.startSec, t, cw, ch);

  if (UI.viewportInfo){
    UI.viewportInfo.textContent = `view: ${secToHMS(range.startSec)}–${secToHMS(range.endSec)} / zoom ${cfg.pxPerSec}px/s`;
  }

  // schedule tile generation (debounced by scroll idle, but calling here is safe)
  if (!abortCtrl) abortCtrl = new AbortController();
  ensureTilesForRange(cfg, range);
}

/** ====== Seek / Playback ====== */
async function playFrom(sec){
  if (!analyzer.inited || !UI.fullAudio) return;
  sec = clamp(sec, 0, Math.max(0, analyzer.duration - 0.001));

  // ensure audio ctx resumed
  try { if (analyzer.audioCtx?.state === 'suspended') await analyzer.audioCtx.resume(); } catch {}

  // ensure analysis loop running (muted)
  if (!analyzer.analysisPlaying){
    try{
      await analyzer.audio.play();
      analyzer.analysisPlaying = true;
    } catch {}
  }

  // audible playback uses fullAudio
  UI.fullAudio.currentTime = sec;
  try{ await UI.fullAudio.play(); } catch {}
  scheduleRender();
}

/** ====== PNG export ====== */
async function exportVisiblePNG(){
  if (!analyzer.inited || !UI.specCanvas) return;
  setState('PNG作成中');
  if (UI.exportViewBtn) UI.exportViewBtn.disabled = true;
  try{
    const blob = await new Promise(r => UI.specCanvas.toBlob(r, 'image/png'));
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    downloadBlob(blob, `spectrogram_view_${stamp}.png`);
    setState('準備完了');
  } catch(e){
    setState('エラー');
    logLine(`PNG(表示)失敗: ${e?.message ?? e}`);
  } finally {
    if (UI.exportViewBtn) UI.exportViewBtn.disabled = false;
  }
}

function renderRangeToCanvas(targetCanvas, cfg, startSec, endSec){
  const ctx = targetCanvas.getContext('2d', { alpha:false });
  const cw = targetCanvas.width, ch = targetCanvas.height;
  const plotH = ch - PAD_T - PAD_B;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,cw,ch);

  drawAxis(ctx, cfg, plotH, cw, ch);
  drawTimeTopGrid(ctx, cfg, startSec, endSec, cw, ch);
  drawBandHighlight(ctx, cfg, plotH, cw);

  const startIdx = Math.floor(startSec / cfg.tileSec);
  const endIdx = Math.floor(endSec / cfg.tileSec);

  for (let ti=startIdx; ti<=endIdx; ti++){
    const keyFull = makeTileKey(ti, cfg);
    const tile = tileCache.get(keyFull);
    if (!tile) continue;

    const tileStart = ti * cfg.tileSec;
    const tileEnd = tileStart + cfg.tileSec;
    const drawStart = Math.max(startSec, tileStart);
    const drawEnd = Math.min(endSec, tileEnd);
    if (drawEnd <= drawStart) continue;

    const srcX0 = (drawStart - tileStart) * cfg.fps;
    const srcX1 = (drawEnd - tileStart) * cfg.fps;
    const srcW = Math.max(1, srcX1 - srcX0);

    const dstX0 = AXIS_W + (drawStart - startSec) * cfg.pxPerSec;
    const dstW = (drawEnd - drawStart) * cfg.pxPerSec;

    ctx.drawImage(tile.bitmap, srcX0, 0, srcW, tile.height, dstX0, PAD_T, dstW, plotH);
  }

  drawDetectionsOverlay(ctx, cfg, startSec, endSec, cw, ch);
  const t = UI.fullAudio?.currentTime || 0;
  drawPlayhead(ctx, cfg, startSec, t, cw, ch);
}

async function exportRangePNG(){
  if (!analyzer.inited) return;
  setState('PNG作成中');
  if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = true;
  try{
    const cfg0 = getConfig();
    const s = clamp(parseFloat(UI.exportStartSec?.value) || 0, 0, analyzer.duration);
    const e = clamp(parseFloat(UI.exportEndSec?.value) || Math.min(analyzer.duration, s+30), 0, analyzer.duration);
    const start = Math.min(s,e), end = Math.max(s,e);
    const span = Math.max(0.1, end-start);

    const desiredW = Math.floor(span * cfg0.pxPerSec) + AXIS_W;
    const maxW = 8000;
    const scale = desiredW > maxW ? (maxW / desiredW) : 1.0;

    const rect = UI.viewport.getBoundingClientRect();
    const h = Math.max(300, Math.floor(rect.height));
    const w = Math.max(800, Math.floor(desiredW * scale));

    const oc = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : (() => { const c=document.createElement('canvas'); c.width=w; c.height=h; return c; })();

    const cfg = { ...cfg0, pxPerSec: cfg0.pxPerSec * scale };
    renderRangeToCanvas(oc, cfg, start, end);

    const blob = await (oc.convertToBlob ? oc.convertToBlob({type:'image/png'}) : new Promise(r => oc.toBlob(r, 'image/png')));
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    downloadBlob(blob, `spectrogram_${Math.floor(start)}-${Math.floor(end)}s_${stamp}.png`);
    setState('準備完了');
  } catch(e){
    setState('エラー');
    logLine(`PNG(範囲)失敗: ${e?.message ?? e}`);
  } finally {
    if (UI.exportRangeBtn) UI.exportRangeBtn.disabled = false;
  }
}


function spectrumStats(tmp){
  let max = -Infinity, min = Infinity;
  let finite = 0;
  for (let i=0;i<tmp.length;i++){
    const v = tmp[i];
    if (Number.isFinite(v)){
      finite++;
      if (v>max) max=v;
      if (v<min) min=v;
    }
  }
  return { max, min, finite, n: tmp.length };
}

async function runDiagnostics(){
  if (!analyzer.inited){
    logLine('diag: 未準備（先に 読み込み/準備）');
    return;
  }
  const cfg = getConfig();
  analyzer.analyser.fftSize = cfg.fftSize;
  analyzer.analyser.minDecibels = cfg.minDb;
  analyzer.analyser.maxDecibels = cfg.maxDb;
  analyzer.analyser.smoothingTimeConstant = 0;

  const bins = analyzer.analyser.frequencyBinCount;
  const tmp = new Float32Array(bins);

  const range = getViewportRange(cfg);
  const t0 = clamp(range.startSec, 0, Math.max(0, analyzer.duration-0.001));
  const t1 = clamp(t0 + 1.0, 0, Math.max(0, analyzer.duration-0.001));

  // make sure analysis element is playing
  try{ if (analyzer.audioCtx?.state === 'suspended') await analyzer.audioCtx.resume(); } catch {}
  if (analyzer.audio?.paused){ try{ await analyzer.audio.play(); analyzer.analysisPlaying = true; } catch {} }

  await seekAndWait(analyzer.audio, t0, 800);
  analyzer.analyser.getFloatFrequencyData(tmp);
  const s0 = spectrumStats(tmp);

  await seekAndWait(analyzer.audio, t1, 800);
  analyzer.analyser.getFloatFrequencyData(tmp);
  const s1 = spectrumStats(tmp);

  logLine(`diag: analysisPaused=${analyzer.audio.paused} ctx=${analyzer.audioCtx.state} dur=${secToHMS(analyzer.duration)}`);
  logLine(`diag@${secToHMS(t0)}: finite=${s0.finite}/${s0.n} max=${s0.max.toFixed(1)} min=${s0.min.toFixed(1)}`);
  logLine(`diag@${secToHMS(t1)}: finite=${s1.finite}/${s1.n} max=${s1.max.toFixed(1)} min=${s1.min.toFixed(1)}`);
  logLine('diag: max がずっと minDb 付近なら「解析音が入ってない（無音/デコード失敗/シーク未反映）」です');
}

/** ====== Scan (trigger detection) ====== */
let scanAbort = null;
let scanHits = []; // {start,end,peakDb,peakTime}

function setScanUI(running){
  if (UI.scanBtn) UI.scanBtn.disabled = !analyzer.inited || running;
  if (UI.scanStopBtn) UI.scanStopBtn.disabled = !running;
  for (const el of [UI.scanMinHz, UI.scanMaxHz, UI.scanThresholdDb, UI.scanStepSec, UI.presetSmallBird, UI.presetRaptor, UI.presetAll]){
    if (el) el.disabled = running;
  }
}
function updateDetectList(){
  if (UI.detectCount) UI.detectCount.textContent = `${scanHits.length}件`;
  if (!UI.detectList) return;
  UI.detectList.innerHTML = '';
  for (const h of scanHits){
    const div = document.createElement('div');
    div.className = 'hit';
    const t = document.createElement('div');
    t.className = 't mono';
    t.textContent = `${secToHMS(h.start)}–${secToHMS(h.end)}`;
    const v = document.createElement('div');
    v.className = 'v mono';
    v.textContent = `peak:${h.peakDb.toFixed(1)}dB`;
    div.appendChild(t); div.appendChild(v);
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
  for (let i=lo;i<=hi;i++){
    const db = tmpDb[i];
    const p = Math.pow(10, (Math.max(-120, db) / 10));
    sumP += p;
  }
  // SUM energy in band (not average): easier thresholding for detection
  return 10 * Math.log10(Math.max(1e-12, sumP));
}

async function runScanAsync(){
  if (!analyzer.inited) return;

  const cfg = getConfig();
  const minHz = clamp(parseInt(UI.scanMinHz?.value || '3000', 10), 0, 24000);
  const maxHzU = clamp(parseInt(UI.scanMaxHz?.value || String(cfg.maxHz), 10), 0, 24000);
  const maxHz = Math.max(minHz, Math.min(cfg.maxHz, maxHzU));
  const thr = clamp(parseInt(UI.scanThresholdDb?.value || '-55', 10), -120, 0);
  const stepSec = clamp(parseFloat(UI.scanStepSec?.value || '0.5'), 0.1, 2.0);

  // setup analyser
  analyzer.analyser.fftSize = cfg.fftSize;
  analyzer.analyser.minDecibels = cfg.minDb;
  analyzer.analyser.maxDecibels = cfg.maxDb;
  analyzer.analyser.smoothingTimeConstant = 0;

  const bins = analyzer.analyser.frequencyBinCount;
  const tmp = new Float32Array(bins);

  scanHits = [];
  updateDetectList();
  if (UI.scanBarFill) UI.scanBarFill.style.width = '0%';
  if (UI.scanStatus) UI.scanStatus.textContent = `scan: 0/${secToHMS(analyzer.duration)} step=${stepSec}s band=${minHz}-${maxHz}Hz thr=${thr}dB(energy)`;

  scanAbort = new AbortController();
  setScanUI(true);
  setState('スキャン中');

  try{
    const dur = analyzer.duration;
    const groupGap = Math.max(stepSec * 1.5, 0.75);
    let cur = null;
    let t = 0;
    let iter = 0;

    // ensure analysis loop running
    if (!analyzer.analysisPlaying){
      try { await analyzer.audio.play(); analyzer.analysisPlaying = true; } catch {}
    }

    while (t < dur){
      if (scanAbort.signal.aborted) break;

      // reuse: if tile exists, use its feature bands
      let meanDb = null;
      let peakDb = null;

      const ti = Math.floor(t / cfg.tileSec);
      const key = makeTileKey(ti, cfg);
      const tile = tileCache.get(key);
      if (tile && tile.featCols && tile.featEdges){
        const col = Math.floor((t - (ti*cfg.tileSec)) * cfg.fps);
        const idx = clamp(col, 0, tile.featCols.length - 1);
        const fb = tile.featCols[idx];
        meanDb = featureBandsToMeanDb(fb, tile.featEdges, minHz, maxHz);
        peakDb = featureBandsPeakDb(fb, tile.featEdges, minHz, maxHz);
      }

      if (meanDb === null){
        await seekAndWait(analyzer.audio, clamp(t, 0, Math.max(0, analyzer.duration-0.001)), 650);
        if (analyzer.audio.paused){ try{ await analyzer.audio.play(); analyzer.analysisPlaying = true; } catch {} }
        analyzer.analyser.getFloatFrequencyData(tmp);
        meanDb = bandMeanDbFromSpectrum(tmp, cfg, minHz, maxHz);

        // peak for display
        const sr = analyzer.audioCtx.sampleRate;
        const binHz = sr / cfg.fftSize;
        const lo = clamp(Math.floor(minHz / binHz), 0, bins-1);
        const hi = clamp(Math.ceil(maxHz / binHz), 0, bins-1);
        let pk = -120;
        for (let i=lo;i<=hi;i++) pk = Math.max(pk, tmp[i]);
        peakDb = pk;
      }

      if (meanDb >= thr){
        const peak = (peakDb ?? meanDb);
        if (!cur){
          cur = { start: t, end: t, peakDb: peak, peakTime: t };
        } else if (t - cur.end <= groupGap){
          cur.end = t;
          if (peak > cur.peakDb){ cur.peakDb = peak; cur.peakTime = t; }
        } else {
          scanHits.push({ ...cur, end: Math.min(cur.end + stepSec, dur) });
          cur = { start: t, end: t, peakDb: peak, peakTime: t };
        }
      }

      t += stepSec;
      iter++;

      if (iter % 10 === 0){
        const p = clamp(t / dur, 0, 1);
        if (UI.scanBarFill) UI.scanBarFill.style.width = `${(p*100).toFixed(1)}%`;
        if (UI.scanStatus) UI.scanStatus.textContent = `scan: ${secToHMS(t)}/${secToHMS(dur)} hits=${scanHits.length}${cur?'+':''}`;
        await sleep(0);
        scheduleRender();
      }
    }

    if (cur) scanHits.push({ ...cur, end: Math.min(cur.end + stepSec, analyzer.duration) });

    updateDetectList();
    if (UI.scanBarFill) UI.scanBarFill.style.width = '100%';
    if (UI.scanStatus) UI.scanStatus.textContent = `scan: 完了 hits=${scanHits.length}`;
    setState('準備完了');
    logLine(`scan done: ${scanHits.length} hits`);
    scheduleRender();
  } catch(e){
    setState('エラー');
    logLine(`scan fail: ${e?.message ?? e}`);
  } finally {
    setScanUI(false);
    scanAbort = null;
  }
}

/** ====== UI wiring ====== */
function wire(){
  if (UI.clearBtn) UI.clearBtn.addEventListener('click', clearAll);

  if (UI.prepareBtn) UI.prepareBtn.addEventListener('click', async () => {
    try{
      UI.prepareBtn.disabled = true;
      await prepare();
    } catch(e){
      setState('エラー');
      logLine(`prepare fail: ${e?.message ?? e}`);
    } finally {
      UI.prepareBtn.disabled = false;
    }
  });

  if (UI.playBtn) UI.playBtn.addEventListener('click', async () => {
    if (!analyzer.inited) return;
    await playFrom(UI.fullAudio?.currentTime || 0);
  });
  if (UI.pauseBtn) UI.pauseBtn.addEventListener('click', () => { try { UI.fullAudio?.pause(); } catch {} });
  if (UI.stopBtn) UI.stopBtn.addEventListener('click', () => { try { UI.fullAudio?.pause(); UI.fullAudio.currentTime = 0; } catch {} scheduleRender(); });

  if (UI.exportViewBtn) UI.exportViewBtn.addEventListener('click', exportVisiblePNG);
  if (UI.exportRangeBtn) UI.exportRangeBtn.addEventListener('click', exportRangePNG);

  // settings changes -> rerender
  const onSettingChanged = () => { scheduleRender(); };
  const listen = (el) => { if (!el) return; ['change','input'].forEach(evt => el.addEventListener(evt, onSettingChanged)); };
  [UI.tileSec, UI.fps, UI.fftSize, UI.maxHz, UI.minDb, UI.maxDb, UI.cmap, UI.freqScale, UI.pxPerSec, UI.cacheTiles, UI.hlMinHz, UI.hlMaxHz].forEach(listen);

  if (UI.viewport){
    let scrollIdleTimer = 0;
    UI.viewport.addEventListener('scroll', () => {
      scheduleRender();
      if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => { scheduleRender(); }, SCROLL_IDLE_MS);
    });
  }

  if (UI.specCanvas){
    UI.specCanvas.addEventListener('click', async (ev) => {
      if (!analyzer.inited) return;
      const cfg = getConfig();
      const rect = UI.specCanvas.getBoundingClientRect();
      const x = ev.clientX - rect.left - AXIS_W;
      const sec = (UI.viewport.scrollLeft / cfg.pxPerSec) + (x / cfg.pxPerSec);
      await playFrom(sec);
    });
  }

  if (UI.fullAudio){
    UI.fullAudio.addEventListener('timeupdate', scheduleRender);
    UI.fullAudio.addEventListener('play', scheduleRender);
    UI.fullAudio.addEventListener('pause', scheduleRender);
    UI.fullAudio.addEventListener('seeked', scheduleRender);
  }

  if (UI.presetSmallBird){
    UI.presetSmallBird.addEventListener('click', () => { UI.scanMinHz.value = 3000; UI.scanMaxHz.value = 12000; });
    UI.presetRaptor.addEventListener('click', () => { UI.scanMinHz.value = 1500; UI.scanMaxHz.value = 8000; });
    UI.presetAll.addEventListener('click', () => { UI.scanMinHz.value = 0; UI.scanMaxHz.value = String(getConfig().maxHz); });
  }
  if (UI.scanBtn){
    UI.scanBtn.addEventListener('click', runScanAsync);
    UI.scanStopBtn.addEventListener('click', () => { if (scanAbort) scanAbort.abort(); });
  }

  window.addEventListener('resize', () => { resizeCanvas(); scheduleRender(); });
}

wire();
clearAll();
