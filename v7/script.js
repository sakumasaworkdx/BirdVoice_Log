/* eslint-disable no-console */
'use strict';

/**
 * v5 追加
 * - 解析結果を全出力（全件一括保存 ZIP）
 *   - スペクトラム全件オフスクリーン画像（JPG）
 *   - 音声全件切り出し（WAV, ±5秒）
 *   - CSV（検出時刻・画像ファイル名）
 *   - JSZip で一括 ZIP ダウンロード
 *   - async/await 逐次処理 + 進捗表示
 *
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
  scanSegSec: document.getElementById('scanSegSec'),
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

  // bulk export
  exportAllBtn: document.getElementById('exportAllBtn'),
  exportProgress: document.getElementById('exportProgress'),

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
  // 新方式ではAnalyserNode/MediaElementSourceは不要
  // 再生は UI.fullAudio で直接行い、解析はオフラインFFTで行う
  analyzer.file = file;
  analyzer.inited = true;
  logLine(`ファイル準備完了: ${file.name}`);
}

// ── Audio Chunk Cache ────────────────────────────────────────────────────────
// MP3/AACはバイトスライスでdecodeAudioDataできないため、ファイル全体を1回デコードする。
// 長尺ファイルのメモリ問題を解決するため、デコード直後に5分チャンクへ分割して
// ── Audio Chunk Cache ────────────────────────────────────────────────────────
//
// 設計目標: 8時間ファイルを1GB以内で処理
//
// フォーマット別戦略:
//   WAV  → RIFFヘッダーを読んでPCMバイトを直接Float32変換（デコード不要・ピーク50MB以下）
//   MP3/AAC → 15分セグメント単位でdecodeAudioData（ピーク≈150MB）
//
// 共通: チャンクはLRUで最大6個（≈180〜300MB）だけ保持し古いものを自動解放

const AUDIO_CHUNK_SEC  = 5 * 60;   // 1チャンク = 5分
const MAX_AUDIO_CHUNKS = 6;         // LRU上限（ピーク + 保持 ≦ 約1GB に収まる値）

// MP3/AACをセグメント単位でデコードする際の1セグメントの長さ
// 長いほど確実にデコードできるが、ピークメモリが増える（15分 ≈ 150MB）
const DECODE_SEG_SEC   = 15 * 60;
const DECODE_OVERLAP_SEC = 2;       // セグメント境界で音が途切れないよう前後に余裕

// Map<chunkIndex, { mono: Float32Array, sr: number, lastUsed: number }>
const audioChunkCache = new Map();

// チャンク生成中のPromiseを管理（同一チャンクの重複デコードを防ぐ）
const _chunkInflight = new Map(); // chunkIdx → Promise

let _audioChunkFile = null;  // 現在キャッシュ対象のFileオブジェクト
let _wavInfo        = null;  // WAVのみ: パース済みヘッダー情報
let _sharedDecodeCtx = null; // MP3/AAC: AudioContextを使い回す（ブラウザの上限対策）

// ── キャッシュ管理 ────────────────────────────────────────────────────────

function clearAudioChunkCache() {
  audioChunkCache.clear();
  _chunkInflight.clear();
  _audioChunkFile = null;
  _wavInfo        = null;
  // shared decode contextはclose()しない（再利用するため）
  // ファイル切り替え時のキャッシュクリアだけ行う
}

function pruneAudioChunks() {
  if (audioChunkCache.size <= MAX_AUDIO_CHUNKS) return;
  const sorted = [...audioChunkCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [k] of sorted.slice(0, audioChunkCache.size - MAX_AUDIO_CHUNKS)) {
    audioChunkCache.delete(k);
  }
}

function releaseFullBuffer() { clearAudioChunkCache(); }

// ── WAVヘッダーパーサー ───────────────────────────────────────────────────

async function parseWavHeader(file) {
  // BWF/iXML/大きなID3タグ付きWAVに対応するため十分なサイズを読む
  // ただしファイルサイズ以上は読まない
  const READ_SIZE = Math.min(file.size, 65536);
  const headerAb = await file.slice(0, READ_SIZE).arrayBuffer();
  const dv       = new DataView(headerAb);
  const txt      = s => String.fromCharCode(...new Uint8Array(headerAb, s, 4));

  if (txt(0) !== 'RIFF' || txt(8) !== 'WAVE') throw new Error('WAVフォーマットではありません');

  let offset = 12;
  let audioFmt = 0, channels = 0, sampleRate = 0, bitsPerSample = 0;
  let dataOffset = 0, dataSize = 0;

  while (offset + 8 <= READ_SIZE) {
    const id   = txt(offset);
    const size = dv.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      audioFmt     = dv.getUint16(offset + 8,  true); // 1=PCM, 3=IEEE Float
      channels     = dv.getUint16(offset + 10, true);
      sampleRate   = dv.getUint32(offset + 12, true);
      bitsPerSample = dv.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize   = size;
      break;
    }
    // dataチャンクが読み込み範囲を超える場合: サイズ分スキップすると
    // READ_SIZE外に出るので、そこで探索打ち切り → dataOffset=0 のまま
    const nextOffset = offset + 8 + size + (size & 1);
    if (nextOffset <= offset) break; // サイズ異常によるループ防止
    offset = nextOffset;
  }

  if (!sampleRate || !dataOffset) throw new Error('WAVヘッダー解析失敗（dataチャンクが見つかりません。BWF等の場合はヘッダーが大きすぎる可能性があります）');
  if (audioFmt !== 1 && audioFmt !== 3) throw new Error(`非対応WAVフォーマット (audioFmt=${audioFmt})`);

  const bytesPerSample = bitsPerSample >> 3;
  const blockAlign     = channels * bytesPerSample;
  const totalSamples   = Math.floor(dataSize / blockAlign);
  const duration       = totalSamples / sampleRate;

  return { sampleRate, channels, bitsPerSample, audioFmt, dataOffset, dataSize, bytesPerSample, blockAlign, totalSamples, duration };
}

/**
 * WAV PCMバイトをFloat32に変換（デコード不要・低メモリ）
 */
function pcmBytesToFloat32(ab, bitsPerSample, audioFmt) {
  const dv = new DataView(ab);
  const n  = ab.byteLength / (bitsPerSample >> 3);
  const out = new Float32Array(n);
  if (audioFmt === 3) { // 32bit IEEE float
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  } else if (bitsPerSample === 16) {
    const inv = 1 / 32768;
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) * inv;
  } else if (bitsPerSample === 24) {
    const inv = 1 / 8388608;
    for (let i = 0; i < n; i++) {
      const b0 = dv.getUint8(i*3), b1 = dv.getUint8(i*3+1), b2 = dv.getUint8(i*3+2);
      const v  = (b2 << 16) | (b1 << 8) | b0;
      out[i]   = ((v & 0x800000) ? v - 0x1000000 : v) * inv;
    }
  } else if (bitsPerSample === 8) {
    const inv = 1 / 128;
    for (let i = 0; i < n; i++) out[i] = (dv.getUint8(i) - 128) * inv;
  } else if (bitsPerSample === 32) {
    const inv = 1 / 2147483648;
    for (let i = 0; i < n; i++) out[i] = dv.getInt32(i * 4, true) * inv;
  }
  return out;
}

// ── チャンク取得（フォーマット自動判別） ─────────────────────────────────

function isWavFile(file) {
  const n = (file?.name || '').toLowerCase();
  const t = (file?.type || '').toLowerCase();
  return t.includes('wav') || n.endsWith('.wav') || n.endsWith('.wave');
}

/**
 * 指定チャンクのモノラルFloat32を返す（キャッシュ優先）。
 * WAVは直接PCM変換、MP3/AACはセグメントデコード。
 */
async function fetchAudioChunk(chunkIdx, file) {
  // キャッシュヒット
  const cached = audioChunkCache.get(chunkIdx);
  if (cached) { cached.lastUsed = Date.now(); return cached; }

  // 重複取得防止
  if (_chunkInflight.has(chunkIdx)) {
    return _chunkInflight.get(chunkIdx);
  }

  const promise = (async () => {
    const chunkStartSec = chunkIdx * AUDIO_CHUNK_SEC;
    const chunkEndSec   = chunkStartSec + AUDIO_CHUNK_SEC;

    let mono, sr;

    if (isWavFile(file)) {
      // ── WAV: PCMバイト直接変換 ─────────────────────────────────────────
      if (!_wavInfo) _wavInfo = await parseWavHeader(file);
      const info = _wavInfo;
      sr = info.sampleRate;

      const startSample = Math.min(info.totalSamples, Math.floor(chunkStartSec * sr));
      const endSample   = Math.min(info.totalSamples, Math.ceil(Math.min(chunkEndSec, info.duration) * sr));

      // チャンネルをインタリーブで読む → チャンネル0だけ抽出
      const startByte = info.dataOffset + startSample * info.blockAlign;
      const endByte   = info.dataOffset + endSample   * info.blockAlign;
      const ab        = await file.slice(startByte, endByte).arrayBuffer();
      const allCh     = pcmBytesToFloat32(ab, info.bitsPerSample, info.audioFmt);

      if (info.channels === 1) {
        mono = allCh;
      } else {
        // 複数チャンネル: ch0だけ抽出（インタリーブ解除）
        mono = new Float32Array(Math.floor(allCh.length / info.channels));
        for (let i = 0; i < mono.length; i++) mono[i] = allCh[i * info.channels];
      }

    } else {
      // ── MP3/AAC: セグメント単位でdecodeAudioData ───────────────────────
      // DECODE_SEG_SEC（15分）単位でデコードし、必要な5分チャンクを切り出す。
      // セグメント境界の前後に余裕を持たせてデコードの信頼性を高める。
      const segIdx      = Math.floor(chunkStartSec / DECODE_SEG_SEC);
      const segStartSec = Math.max(0, segIdx * DECODE_SEG_SEC - DECODE_OVERLAP_SEC);
      const segEndSec   = Math.min(analyzer.duration, (segIdx + 1) * DECODE_SEG_SEC + DECODE_OVERLAP_SEC);

      const bytesPerSec = file.size / Math.max(1, analyzer.duration);

      // デコード試行（失敗時は範囲を広げてリトライ）
      let segBuf = null;
      const attempts = [
        { startSec: segStartSec, endSec: segEndSec },                           // 通常
        { startSec: Math.max(0, segStartSec - 10), endSec: Math.min(file.size / bytesPerSec, segEndSec + 10) }, // ±10秒拡張
        { startSec: 0, endSec: analyzer.duration },                             // 全体フォールバック（最終手段）
      ];

      for (let ai = 0; ai < attempts.length; ai++) {
        const att = attempts[ai];
        const startByte = Math.max(0, Math.floor(att.startSec * bytesPerSec));
        const endByte   = Math.min(file.size, Math.ceil(att.endSec * bytesPerSec));

        // ファイル全体フォールバックの場合メモリ消費が大きいので警告
        if (ai === 2 && file.size > 500 * 1024 * 1024) {
          logLine(`⚠ MP3/AAC: セグメントデコード失敗 → 全体デコードを試みます（メモリ注意: ${fmtBytes(file.size)}）`);
        }

        const ab = await file.slice(startByte, endByte).arrayBuffer();
        try {
          // AudioContextを使い回す（ブラウザのAudioContext数上限対策）
          if (!_sharedDecodeCtx || _sharedDecodeCtx.state === 'closed') {
            _sharedDecodeCtx = new (window.AudioContext || window.webkitAudioContext)();
          }
          segBuf = await _sharedDecodeCtx.decodeAudioData(ab);
          // 成功した場合、実際の開始時刻を記録
          att._actualStartSec = att.startSec;
          // segStartSecをこのattemptの値に更新（後の切り出しオフセット計算のため）
          if (ai > 0) {
            logLine(`MP3/AAC chunk#${chunkIdx}: デコード成功（試行${ai + 1}回目, 範囲${att.startSec.toFixed(0)}s-${att.endSec.toFixed(0)}s）`);
          }
          // segStartSecをattemptの実際の値に更新
          var actualSegStartSec = att.startSec;
          break;
        } catch (decErr) {
          if (ai < attempts.length - 1) continue; // 次の試行へ
          throw new Error(`MP3/AACデコード失敗(chunk#${chunkIdx}): ${decErr?.message ?? decErr}`);
        }
      }
      // actualSegStartSecが定義されていない場合（通常のパスで成功）
      if (typeof actualSegStartSec === 'undefined') actualSegStartSec = segStartSec;

      sr = segBuf.sampleRate;
      const segData = segBuf.getChannelData(0);

      // セグメント内の「このチャンク」に対応する部分を切り出す
      const chunkInSegStart = Math.floor(Math.max(0, chunkStartSec - actualSegStartSec) * sr);
      const chunkInSegEnd   = Math.min(segData.length, Math.ceil((Math.min(chunkEndSec, analyzer.duration) - actualSegStartSec) * sr));

      mono = new Float32Array(Math.max(0, chunkInSegEnd - chunkInSegStart));
      if (mono.length > 0) {
        mono.set(segData.subarray(chunkInSegStart, chunkInSegEnd));
      }
    }

    const chunk = { mono, sr, lastUsed: Date.now() };
    audioChunkCache.set(chunkIdx, chunk);
    pruneAudioChunks();
    return chunk;
  })();

  _chunkInflight.set(chunkIdx, promise);
  try {
    return await promise;
  } finally {
    _chunkInflight.delete(chunkIdx);
  }
}

// ── 公開API ──────────────────────────────────────────────────────────────

/**
 * 指定時間範囲のモノラルサンプルを返す。
 * @returns {{ mono: Float32Array, sr: number }}
 */
async function getAudioSamples(startSec, endSec) {
  if (!analyzer.file) throw new Error('ファイル未ロード');

  // 新しいファイルに変わっていたらキャッシュ破棄
  if (_audioChunkFile !== analyzer.file) {
    clearAudioChunkCache();
    _audioChunkFile = analyzer.file;
  }

  const firstChunkIdx = Math.floor(startSec / AUDIO_CHUNK_SEC);
  const lastChunkIdx  = Math.floor(Math.max(startSec, endSec - 1e-9) / AUDIO_CHUNK_SEC);

  if (firstChunkIdx === lastChunkIdx) {
    // 典型ケース: 1チャンク内に収まる
    const chunk = await fetchAudioChunk(firstChunkIdx, analyzer.file);
    const sr    = chunk.sr;
    const chunkStartSec = firstChunkIdx * AUDIO_CHUNK_SEC;
    const s = Math.max(0, Math.floor((startSec - chunkStartSec) * sr));
    const e = Math.min(chunk.mono.length, Math.ceil((endSec - chunkStartSec) * sr));
    return { mono: chunk.mono.subarray(s, e), sr };
  }

  // チャンク境界をまたぐ場合: コピーして結合
  const firstChunk = await fetchAudioChunk(firstChunkIdx, analyzer.file);
  const sr         = firstChunk.sr;
  const totalLen   = Math.ceil((endSec - startSec) * sr);
  const result     = new Float32Array(totalLen);
  let   written    = 0;

  for (let ci = firstChunkIdx; ci <= lastChunkIdx && written < totalLen; ci++) {
    const chunk = await fetchAudioChunk(ci, analyzer.file);
    const chunkStartSec = ci * AUDIO_CHUNK_SEC;
    const chunkEndSec   = chunkStartSec + AUDIO_CHUNK_SEC;
    const s = Math.max(0, Math.floor((startSec - chunkStartSec) * sr));
    const e = Math.min(chunk.mono.length, Math.ceil((Math.min(endSec, chunkEndSec) - chunkStartSec) * sr));
    const slice   = chunk.mono.subarray(s, e);
    const copyLen = Math.min(slice.length, totalLen - written);
    result.set(slice.subarray(0, copyLen), written);
    written += copyLen;
  }

  return { mono: result.subarray(0, written), sr };
}

// スキャン開始時にファイル情報を事前確認するだけ（実際のデコードは getAudioSamples で遅延実行）
async function ensureAudioDecoded() {
  if (!analyzer.file) throw new Error('ファイル未ロード');
  if (_audioChunkFile !== analyzer.file) {
    clearAudioChunkCache();
    _audioChunkFile = analyzer.file;
  }
  // WAVの場合はヘッダーだけ事前パース（512バイト読むだけ・瞬時）
  if (isWavFile(analyzer.file) && !_wavInfo) {
    _wavInfo = await parseWavHeader(analyzer.file);
    logLine(`WAV: ${_wavInfo.sampleRate}Hz ${_wavInfo.channels}ch ${_wavInfo.bitsPerSample}bit / ${(_wavInfo.duration/3600).toFixed(2)}時間`);
  }
}

// 後方互換ラッパー（呼び出し箇所がまだあれば動くように）
async function getFullAudioBuffer() {
  const dur = analyzer.duration || 1;
  const { mono, sr } = await getAudioSamples(0, dur);
  return { sampleRate: sr, getChannelData: () => mono, length: mono.length, duration: dur, numberOfChannels: 1 };
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
  ctx.fillStyle = '#111827';
  ctx.fillRect(0,0,AXIS_W,UI.specCanvas.height);

  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.beginPath();
  ctx.moveTo(AXIS_W + 0.5, 0);
  ctx.lineTo(AXIS_W + 0.5, UI.specCanvas.height);
  ctx.stroke();

  const range = cfg.maxHz - cfg.minHz;
  const step = (range <= 6000) ? 500 : 1000;

  ctx.fillStyle = 'rgba(200,210,230,.85)';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  ctx.strokeStyle = `rgba(255,255,255,${GRID_ALPHA})`;
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

  ctx.fillStyle = 'rgba(150,165,200,.7)';
  ctx.fillText('kHz', 10, 16);
}

function drawTimeTopGrid(ctx, cfg, viewStartSec, viewEndSec) {
  const plotX0 = AXIS_W;
  const spanSec = (viewEndSec - viewStartSec);
  const step = (spanSec <= 20) ? 1 : (spanSec <= 120 ? 5 : 10);

  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${GRID_ALPHA})`;
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
  ctx.fillStyle = 'rgba(200,210,230,.80)';
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

const TILE_H = 512;

function yToHzByScale(y, cfg, plotH){
  const t = 1 - (y / Math.max(1, (plotH - 1)));
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
  const tileStart     = tileIndex * cfg.tileSec;
  const tileEnd       = Math.min(analyzer.duration, tileStart + cfg.tileSec);
  const targetSeconds = tileEnd - tileStart;

  if (!analyzer.file) throw new Error('ファイル未ロード');
  if (abortSignal?.aborted) throw new Error('abort');

  // ── ファイル全体のデコード済みバッファを取得（MP3/AACのバイトスライス問題を回避）──
  if (abortSignal?.aborted) throw new Error('abort');
  const { mono, sr } = await getAudioSamples(tileStart, tileEnd);
  if (abortSignal?.aborted) throw new Error('abort');

  {  // ブロックスコープ（try/finallyを削除しシンプルに）

    // ── FFT 準備 ───────────────────────────────────────────────────────
    const FFT_N   = clamp(nextPow2(cfg.fftSize), 512, 4096);
    const halfFFT = (FFT_N >> 1) - 1;
    const plan    = makeFft(FFT_N);
    const re      = new Float32Array(FFT_N);
    const im      = new Float32Array(FFT_N);
    const binHz   = sr / FFT_N;

    // LUT 1: Hann窓
    const hannLUT = new Float32Array(FFT_N);
    for (let n = 0; n < FFT_N; n++) {
      hannLUT[n] = 0.5 * (1.0 - Math.cos((2 * Math.PI * n) / (FFT_N - 1)));
    }

    // LUT 2: y座標 → FFT bin
    const height = TILE_H;
    const binLUT = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      binLUT[y] = clamp(Math.round(yToHzByScale(y, cfg, height) / binHz), 0, halfFFT);
    }

    // LUT 3: カラーパレット
    const CLUT_N   = 1024;
    const CLUT_MAX = CLUT_N - 1;
    const colorLUT = new Uint8Array(CLUT_N * 3);
    for (let i = 0; i < CLUT_N; i++) {
      const [r, g, b] = mapColor(cfg.colorMap, i / CLUT_MAX);
      colorLUT[i * 3] = r; colorLUT[i * 3 + 1] = g; colorLUT[i * 3 + 2] = b;
    }

    // ── キャンバス準備 ──────────────────────────────────────────────────
    const samplesPerCol = Math.max(1, Math.floor(sr / cfg.fps));
    const width         = Math.max(1, Math.floor(targetSeconds * cfg.fps));

    const oc = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(width, height)
      : (() => { const c = document.createElement('canvas'); c.width=width; c.height=height; return c; })();

    const ctx     = oc.getContext('2d', { willReadFrequently: false });
    const imgData = ctx.createImageData(width, height);
    const data    = imgData.data;

    // dB正規化定数（Web Audio AnalyserNode に合わせる）
    const LOG10_SCALE = 10.0 / Math.LN10;
    const invRange    = 1.0 / Math.max(1e-6, cfg.maxDb - cfg.minDb);
    const minDb       = cfg.minDb;
    const normDb      = -20.0 * Math.log10(FFT_N); // Chromium: scaler=1/N → -20*log10(N)

    for (let i = 3; i < data.length; i += 4) data[i] = 255;

    const stride = width * 4;

    for (let x = 0; x < width; x++) {
      if (abortSignal?.aborted) throw new Error('abort');

      const sampleStart = x * samplesPerCol;
      const xBase       = x * 4;

      if (sampleStart + FFT_N > mono.length) {
        if (x > 0) {
          const prev = (x - 1) * 4;
          for (let y = 0; y < height; y++) {
            const row = y * stride;
            data[row + xBase]     = data[row + prev];
            data[row + xBase + 1] = data[row + prev + 1];
            data[row + xBase + 2] = data[row + prev + 2];
          }
        }
        continue;
      }

      for (let n = 0; n < FFT_N; n++) {
        re[n] = mono[sampleStart + n] * hannLUT[n];
        im[n] = 0;
      }
      fftInPlace(re, im, plan);

      for (let y = 0; y < height; y++) {
        const bin = binLUT[y];
        const rr  = re[bin], ii = im[bin];
        const db  = LOG10_SCALE * Math.log(rr * rr + ii * ii + 1e-12) + normDb;
        const ci  = clamp(((db - minDb) * invRange * CLUT_MAX + 0.5) | 0, 0, CLUT_MAX) * 3;
        const idx = y * stride + xBase;
        data[idx]     = colorLUT[ci];
        data[idx + 1] = colorLUT[ci + 1];
        data[idx + 2] = colorLUT[ci + 2];
      }

      if ((x & 63) === 63) await sleep(0);
    }

    ctx.putImageData(imgData, 0, 0);
    const bitmap = await createImageBitmap(oc);
    return { bitmap, width, height, tileIndex, tileStart, tileSec: cfg.tileSec, lastUsed: nowMs() };

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
    if (tileInFlight.size >= 3) continue;

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

  if (targetCanvas === UI.specCanvas) resizeCanvasToViewport();

  const ctx = targetCanvas.getContext('2d', { alpha:false, willReadFrequently:false });
  ctx.fillStyle = '#0b0f1c';
  ctx.fillRect(0,0,targetCanvas.width, targetCanvas.height);

  const plotH = Math.max(1, targetCanvas.height - PAD_T - PAD_B);
  const range = getVisibleTimeRange(cfg);
  if (targetCanvas === UI.specCanvas) updateLabels(range);

  drawAxis(ctx, cfg, plotH);
  drawTimeTopGrid(ctx, cfg, range.startSec, range.endSec);

  drawBandHighlight(ctx, cfg, plotH);

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

    ctx.drawImage(
      tile.bitmap,
      srcX0, 0, srcW, tile.height,
      dstX0, PAD_T, dstW, plotH
    );
  }

  const t = UI.fullAudio.currentTime || 0;
  drawPlayhead(ctx, cfg, range.startSec, t);

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

// 再生リクエストの連番管理（連打・競合防止）
let _playSeq = 0;

async function playFrom(timeSec) {
  if (!analyzer.inited) return;

  // 新しいリクエストの番号を確保
  const seq = ++_playSeq;

  // ① 先に必ず一時停止してから seek（play/pause 競合を防ぐ）
  try { UI.fullAudio.pause(); } catch {}
  UI.fullAudio.style.display = 'block';
  UI.fullAudio.currentTime = clamp(timeSec, 0, analyzer.duration);

  // ② 1フレーム分だけ待って currentTime を確定させる
  await sleep(0);

  // 自分より新しいリクエストが来ていたら何もしない
  if (seq !== _playSeq) return;

  try {
    await UI.fullAudio.play();
  } catch (e) {
    // AbortError はブラウザが連続 play() を中断しただけなので無視
    if (e?.name === 'AbortError') return;
    logLine(`再生失敗: ${e?.message ?? e}`);
    return;
  }

  if (seq !== _playSeq) { try { UI.fullAudio.pause(); } catch {} return; }

  startPlayheadLoop();
  scheduleRender();
}

/** ===================== Export PNG (visible) ===================== */
async function exportVisiblePNG() {
  if (!analyzer.inited) return;
  setState('PNG作成中');
  UI.exportViewBtn.disabled = true;
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
  clearAudioChunkCache();

  // MP3/AAC用共有AudioContextをクリーンアップ
  if (_sharedDecodeCtx) {
    try { _sharedDecodeCtx.close(); } catch {}
    _sharedDecodeCtx = null;
  }

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
  UI.exportAllBtn.disabled = true;
  UI.exportProgress.textContent = '';
  UI.exportProgress.className = '';

  UI.spacer.style.width = '0px';
  UI.viewport.scrollLeft = 0;

  resizeCanvasToViewport();
  const ctx = UI.specCanvas.getContext('2d', { alpha:false });
  ctx.fillStyle = '#0b0f1c';
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

    const cfg = getConfig();
    const totalW = Math.max(1, Math.floor(duration * cfg.pxPerSec));
    UI.spacer.style.width = `${totalW}px`;
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

UI.specCanvas.addEventListener('click', async (ev) => {
  if (!analyzer.inited) return;
  const cfg = getConfig();
  const rect = UI.specCanvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  if (x < AXIS_W) return;
  const time = (UI.viewport.scrollLeft + x - AXIS_W) / cfg.pxPerSec;
  await playFrom(time);
});

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

/** ファイル名用タイムスタンプ: h-mm-ss （例: 0-03-21） */
function fmtFileTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}-${String(m).padStart(2,'0')}-${String(s).padStart(2,'0')}`;
}

function setScanProgress(pct){
  const v = clamp(pct, 0, 100);
  UI.scanPct.textContent = `${v.toFixed(0)}%`;
  UI.scanBar.style.width = `${v.toFixed(2)}%`;
}

function clearDetectList(){
  UI.detectList.innerHTML = '';
  UI.exportAllBtn.disabled = true;
  UI.exportProgress.textContent = '';
  UI.exportProgress.className = '';
}

function addDetectButton(sec){
  const btn = document.createElement('button');
  btn.textContent = fmtHMS(sec);
  btn.className = 'mono';
  btn.dataset.sec = String(sec);
  btn.addEventListener('click', async () => {
    if (!analyzer.inited) return;
    await playFrom(sec);
  });
  UI.detectList.appendChild(btn);
  // 1件以上検出されたら全件出力ボタンを有効化
  UI.exportAllBtn.disabled = false;
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

    if (UI.scanMinHzVal) UI.scanMinHzVal.value = String(min);
    if (UI.scanMaxHzVal) UI.scanMaxHzVal.value = String(max);
    if (UI.scanThresholdVal) UI.scanThresholdVal.value = String(thr);
  };

  UI.scanMinHz.addEventListener('input', syncAll);
  UI.scanMaxHz.addEventListener('input', syncAll);
  UI.scanThreshold.addEventListener('input', syncAll);

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

  const setPreset = (min, max, segSec, thrDelta) => {
    UI.scanMinHz.value = String(min);
    UI.scanMaxHz.value = String(max);
    UI.scanThreshold.value = String(thrDelta);
    if (UI.scanSegSec) UI.scanSegSec.value = String(segSec);
    syncAll();
  };
  UI.presetNight?.addEventListener('click', () => setPreset(800, 4000, 2.0, 12));
  UI.presetOwl?.addEventListener('click', () => setPreset(400, 1200, 3.0, 10));
  UI.presetTora?.addEventListener('click', () => setPreset(2000, 2800, 1.0, 15));

  UI.scanSegSec?.addEventListener('input', () => {
    const v = parseFloat(UI.scanSegSec.value);
    if (!Number.isFinite(v)) return;
    UI.scanSegSec.value = String(clamp(v, 0.5, 10.0));
  });

  syncAll();
}

// readWavHeader は parseWavHeader に統合済み（削除）

function makeFft(fftSize){
  const N = fftSize;
  const rev = new Uint32Array(N);
  const logN = Math.log2(N);
  for (let i=0;i<N;i++){
    let x = i, y = 0;
    for (let b=0;b<logN;b++){ y = (y<<1) | (x & 1); x >>= 1; }
    rev[i]=y;
  }
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

// decodePcmMono は pcmBytesToFloat32 に統合済み（削除）


function getScanSegSec(){
  const v = parseFloat(UI.scanSegSec?.value ?? '2.0');
  const seg = Number.isFinite(v) ? v : 2.0;
  return clamp(seg, 0.5, 10.0);
}

// scanBandWav は scanBandDecode に統合済み（削除）
// WAVファイルもチャンクキャッシュ経由の scanBandDecode で処理される


async function scanBandDecode(file){
  const SEG_SEC = getScanSegSec();

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

  const FFT_N = 2048;
  const plan = makeFft(FFT_N);
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);

  const minHz = clamp(parseInt(UI.scanMinHz.value,10)||0, 0, 24000);
  const maxHz = clamp(parseInt(UI.scanMaxHz.value,10)||0, 0, 24000);
  const thrDeltaDb = clamp(parseInt(UI.scanThreshold.value,10)||15, 0, 40);
  const lo = Math.min(minHz, maxHz);
  const hi = Math.max(minHz, maxHz);

  // ── 音声初期化（WAVはヘッダーのみ読む・MP3/AACは最初のチャンク取得時にデコード）─
  await ensureAudioDecoded();
  if (sig.aborted) throw new Error('スキャン中断');

  // srはチャンク0を実際に取得して確認（ノイズ区間より前に取得しておく）
  const _chunk0 = await fetchAudioChunk(0, analyzer.file);
  const sr    = _chunk0.sr;
  const binHz = sr / FFT_N;
  const minBin = clamp(Math.floor(lo / binHz), 0, (FFT_N/2)|0);
  const maxBin = clamp(Math.ceil(hi / binHz), 0, (FFT_N/2)|0);

  // ── ノイズベースライン学習 ────────────────────────────────────────────
  let baselineDb = null;
  try {
    const ns = parseFloat(UI.noiseStartSec?.value ?? '5');
    const ne = parseFloat(UI.noiseEndSec?.value ?? '7');
    let startSec = Number.isFinite(ns) ? ns : 5;
    let endSec   = Number.isFinite(ne) ? ne : 7;
    startSec = Math.max(0, startSec);
    endSec   = Math.max(startSec + 0.2, endSec);

    const { mono: monoN } = await getAudioSamples(startSec, endSec);
    const bins    = Math.max(1, maxBin - minBin + 1);
    const acc     = new Float64Array(bins);
    const hopN    = FFT_N >> 1;
    let framesN   = 0;

    for (let i = 0; i + FFT_N <= monoN.length; i += hopN) {
      for (let n = 0; n < FFT_N; n++) { re[n] = monoN[i+n] * hannWindow(n, FFT_N); im[n] = 0; }
      fftInPlace(re, im, plan);
      for (let b = minBin; b <= maxBin; b++) {
        const rr = re[b], ii = im[b];
        acc[b - minBin] += rr*rr + ii*ii;
      }
      framesN++;
    }

    if (framesN > 0) {
      baselineDb = new Float32Array(bins);
      for (let k = 0; k < bins; k++) baselineDb[k] = 10 * Math.log10((acc[k] / framesN) + 1e-12);
      const mid = Array.from(baselineDb).sort((a,b)=>a-b)[Math.floor(bins*0.5)];
      logLine(`ノイズ学習: ${startSec.toFixed(1)}s〜${endSec.toFixed(1)}s / baseline≈${mid.toFixed(1)} dB (per-bin)`);
    } else {
      logLine('ノイズ学習: フレーム不足（baseline=-120dB扱い）');
    }
  } catch(e) {
    logLine(`ノイズ学習失敗（継続）: ${e?.message ?? e}`);
    baselineDb = null;
  }

  logLine(`スキャン開始: decode方式 / duration≈${duration.toFixed(2)}s / SEG=${SEG_SEC.toFixed(2)}s / FFT=${FFT_N}`);
  logLine(`帯域: ${lo}..${hi} Hz / 検出感度(差分): +${thrDeltaDb} dB`);
  logLine(`判定: SEG内で1フレームでも max( frameDb(bin) - baselineDb(bin) ) > +thr`);

  const hop = FFT_N >> 1;
  let lastDetectedBucket = -9999;

  for (let seg = 0; seg < totalSeg; seg++) {
    if (sig.aborted) throw new Error('スキャン中断');

    const segStartSec = seg * SEG_SEC;
    const segEndSec   = Math.min(duration, segStartSec + SEG_SEC);

    // チャンクキャッシュからサンプル取得（MP3/AACはデコード失敗の可能性あり）
    let mono;
    try {
      const samples = await getAudioSamples(segStartSec, segEndSec);
      mono = samples.mono;
    } catch (e) {
      logLine(`seg#${seg} (${fmtHMS(segStartSec)}) サンプル取得失敗（スキップ）: ${e?.message ?? e}`);
      setScanProgress((seg+1)/totalSeg*100);
      if (seg % 4 === 0) await sleep(0);
      continue;
    }

    let detected = false;

    for (let i = 0; i + FFT_N <= mono.length; i += hop) {
      for (let n = 0; n < FFT_N; n++) { re[n] = mono[i+n] * hannWindow(n, FFT_N); im[n] = 0; }
      fftInPlace(re, im, plan);

      let maxDiffDb = -9999;
      for (let b = minBin; b <= maxBin; b++) {
        const rr = re[b], ii = im[b];
        const frameDb = 10 * Math.log10(rr*rr + ii*ii + 1e-12);
        const base = baselineDb ? baselineDb[b - minBin] : -120;
        if (frameDb - base > maxDiffDb) maxDiffDb = frameDb - base;
      }

      if (maxDiffDb >= thrDeltaDb) { detected = true; break; }
      if (sig.aborted) throw new Error('スキャン中断');
    }

    if (detected) {
      const bucket = Math.floor(segStartSec / SEG_SEC);
      if (bucket !== lastDetectedBucket) {
        addDetectButton(segStartSec);
        lastDetectedBucket = bucket;
      }
    }

    setScanProgress((seg+1)/totalSeg*100);
    if (seg % 4 === 0) await sleep(0);
  }

  logLine('スキャン完了');
  setState('準備完了');
  UI.scanAbortBtn.disabled = true;
}


async function scanBand(file){
  try{
    await scanBandDecode(file);
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


/** ===================== Bulk Export (全件一括出力) ===================== */

/**
 * 次の2のべき乗を返す（FFT用）
 */
function nextPow2(n) {
  let v = 1;
  while (v < n) v <<= 1;
  return v;
}

/**
 * オフスクリーンで1件分のスペクトログラムJPEGを生成する
 * decodeAudioData → FFT → Canvas塗り → JPEG Blob
 * @param {File} file
 * @param {number} timeSec  中心時刻（秒）
 * @param {number} halfSec  前後何秒切り出すか（デフォルト5）
 */
async function generateDetectionSpectrogram(file, timeSec, halfSec = 5) {
  const clipStart = Math.max(0, timeSec - halfSec);
  const clipEnd   = Math.min(analyzer.duration, timeSec + halfSec);
  const clipDur   = Math.max(0.1, clipEnd - clipStart);

  const { mono, sr } = await getAudioSamples(clipStart, clipEnd);

  const cfg  = getConfig();

  const FFT_N   = clamp(nextPow2(cfg.fftSize), 512, 4096);
  const halfFFT = (FFT_N >> 1) - 1;
  const plan    = makeFft(FFT_N);
  const re      = new Float32Array(FFT_N);
  const im      = new Float32Array(FFT_N);
  const binHz   = sr / FFT_N;

  // ── LUT 1: Hann窓 ───────────────────────────────────────────────
  // 毎列 FFT_N 回の Math.cos を 1 回の事前計算に削減
  const hannLUT = new Float32Array(FFT_N);
  for (let n = 0; n < FFT_N; n++) {
    hannLUT[n] = 0.5 * (1.0 - Math.cos((2 * Math.PI * n) / (FFT_N - 1)));
  }

  // ── LUT 2: y行 → FFT bin インデックス ───────────────────────────
  // 毎列 TILE_H 回の Math.log/exp を 1 回の事前計算に削減
  const height  = TILE_H;
  const binLUT  = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    const hz = yToHzByScale(y, cfg, height);
    binLUT[y] = clamp(Math.round(hz / binHz), 0, halfFFT);
  }

  // ── LUT 3: カラーパレット（1024エントリ × RGB）──────────────────
  // 毎ピクセルの mapColor 関数呼び出し＋switch＋配列分割を排除
  const CLUT_N   = 1024;
  const CLUT_MAX = CLUT_N - 1;
  const colorLUT = new Uint8Array(CLUT_N * 3);
  for (let i = 0; i < CLUT_N; i++) {
    const [r, g, b] = mapColor(cfg.colorMap, i / CLUT_MAX);
    colorLUT[i * 3]     = r;
    colorLUT[i * 3 + 1] = g;
    colorLUT[i * 3 + 2] = b;
  }

  // ── 出力幅: 静止画なので 30fps で十分（FFT 回数を半減）──────────
  const EXPORT_FPS    = clamp(Math.min(cfg.fps, 30), 10, 60);
  const samplesPerCol = Math.max(1, Math.floor(sr / EXPORT_FPS));
  const width         = Math.max(1, Math.ceil(clipDur * EXPORT_FPS));

  const oc = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(width, height)
    : (() => { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; })();

  const ctx     = oc.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const data    = imgData.data;

  // Math.log(x) より Math.log10 が遅いブラウザへの対策
  // 10*log10(x) = (10/ln10) * ln(x)
  const LOG10_SCALE = 10.0 / Math.LN10;
  const invRange    = 1.0 / Math.max(1e-6, cfg.maxDb - cfg.minDb);
  const minDb       = cfg.minDb;

  // ── Web Audio AnalyserNode との dB スケール一致補正 ────────────────
  // Chromium RealtimeAnalyser は scaler=1/N で正規化 → normDb = -20*log10(N)
  // 例: FFT_N=1024 → normDb≈-60.2dB, FFT_N=2048 → ≈-66.2dB
  const normDb = -20.0 * Math.log10(FFT_N);

  // 画像の alpha 値をまとめて 255 で初期化
  for (let i = 3; i < data.length; i += 4) data[i] = 255;

  for (let x = 0; x < width; x++) {
    const sampleStart = x * samplesPerCol;
    const xBase       = x * 4;                   // 列先頭のバイトオフセット（stride=width*4）

    if (sampleStart + FFT_N > mono.length) {
      // 末尾: 前の列をそのままコピー
      if (x > 0) {
        const prevXBase = (x - 1) * 4;
        const stride    = width * 4;
        for (let y = 0; y < height; y++) {
          const row = y * stride;
          data[row + xBase]     = data[row + prevXBase];
          data[row + xBase + 1] = data[row + prevXBase + 1];
          data[row + xBase + 2] = data[row + prevXBase + 2];
        }
      }
      continue;
    }

    // Hann窓 + FFT（LUT で cos 計算ゼロ）
    for (let n = 0; n < FFT_N; n++) {
      re[n] = mono[sampleStart + n] * hannLUT[n];
      im[n] = 0;
    }
    fftInPlace(re, im, plan);

    // ピクセル列を書き込む（LUT で log/exp・関数呼び出しゼロ）
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
      const bin  = binLUT[y];
      const rr   = re[bin], ii = im[bin];
      const db   = LOG10_SCALE * Math.log(rr * rr + ii * ii + 1e-12) + normDb;
      const ci   = clamp(((db - minDb) * invRange * CLUT_MAX + 0.5) | 0, 0, CLUT_MAX) * 3;
      const idx  = y * stride + xBase;
      data[idx]     = colorLUT[ci];
      data[idx + 1] = colorLUT[ci + 1];
      data[idx + 2] = colorLUT[ci + 2];
    }

    // 全列がオフスクリーン処理なので yield は 128 列に 1 回で十分
    if ((x & 127) === 127) await sleep(0);
  }

  ctx.putImageData(imgData, 0, 0);

  const blob = await (oc.convertToBlob
    ? oc.convertToBlob({ type: 'image/jpeg', quality: 0.88 })
    : new Promise(res => oc.toBlob(res, 'image/jpeg', 0.88)));

  return blob;
}

/**
 * AudioBuffer → 16bit PCM WAV Blob
 */
function audioBufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate  = audioBuffer.sampleRate;
  const numSamples  = audioBuffer.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign  = numChannels * bytesPerSample;
  const byteRate    = sampleRate * blockAlign;
  const dataSize    = numSamples * blockAlign;
  const totalSize   = 44 + dataSize;

  const ab = new ArrayBuffer(totalSize);
  const dv = new DataView(ab);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  dv.setUint32(4, totalSize - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);          // fmt chunk size
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = clamp(audioBuffer.getChannelData(ch)[i], -1, 1);
      dv.setInt16(offset, Math.round(s * 32767), true);
      offset += 2;
    }
  }

  return new Blob([ab], { type: 'audio/wav' });
}

/**
 * 指定時刻 ±halfSec の音声を WAV Blob として返す
 */
async function extractAudioClipWav(file, timeSec, halfSec = 5) {
  const clipStart = Math.max(0, timeSec - halfSec);
  const clipEnd   = Math.min(analyzer.duration, timeSec + halfSec);

  // チャンクキャッシュからモノラルサンプルを取得してWAV化
  const { mono, sr } = await getAudioSamples(clipStart, clipEnd);

  // audioBufferToWav に渡せる軽量互換オブジェクトを生成
  const clipBuf = {
    sampleRate: sr,
    numberOfChannels: 1,
    length: mono.length,
    getChannelData: () => mono,
  };
  return audioBufferToWav(clipBuf);
}

/**
 * 検出リスト全件を ZIP にまとめてダウンロード
 */
async function exportAll() {
  const file = UI.fileInput.files?.[0];
  if (!file) {
    alert('音声ファイルを選択してください');
    return;
  }
  if (!analyzer.inited) {
    alert('先に「読み込み/準備」を実行してください');
    return;
  }

  if (typeof JSZip === 'undefined') {
    alert('JSZip が読み込まれていません。インターネット接続を確認して再読み込みしてください。');
    return;
  }

  // 検出リストのボタン一覧から秒数を収集
  const buttons = Array.from(UI.detectList.querySelectorAll('button'));
  if (buttons.length === 0) {
    alert('検出リストが空です。先に「全時間スキャン」を実行してください。');
    return;
  }

  const detections = buttons.map(btn => {
    const t = parseFloat(btn.dataset.sec);
    return Number.isFinite(t) ? t : 0;
  });

  UI.exportAllBtn.disabled = true;
  UI.exportProgress.className = '';
  const total = detections.length;

  const setProgress = (msg) => {
    UI.exportProgress.textContent = msg;
  };

  try {
    const zip = new JSZip();
    const imgFolder   = zip.folder('images');
    const audioFolder = zip.folder('audio');

    // CSV ヘッダ（BOM付きUTF-8で Excel 互換）
    const csvRows = [['検出時刻', '画像ファイル名', '', '']];

    for (let i = 0; i < total; i++) {
      const sec         = detections[i];
      const timeLabel   = fmtHMS(sec);
      const fileTimePart = fmtFileTime(sec);
      const imgName     = `cut_${fileTimePart}.jpg`;
      const audioName   = `cut_${fileTimePart}.wav`;

      // --- 画像生成 ---
      setProgress(`画像生成中... (${i + 1}/${total}件) ${timeLabel}`);
      await sleep(0); // UI更新を優先

      let imgBlob = null;
      try {
        imgBlob = await generateDetectionSpectrogram(file, sec, 5);
        imgFolder.file(imgName, imgBlob);
      } catch (e) {
        logLine(`[画像失敗] ${timeLabel}: ${e?.message ?? e}`);
      }

      // --- 音声切り出し ---
      setProgress(`音声切り出し中... (${i + 1}/${total}件) ${timeLabel}`);
      await sleep(0);

      let audioBlob = null;
      try {
        audioBlob = await extractAudioClipWav(file, sec, 5);
        audioFolder.file(audioName, audioBlob);
      } catch (e) {
        logLine(`[音声失敗] ${timeLabel}: ${e?.message ?? e}`);
      }

      csvRows.push([
        timeLabel,
        imgBlob ? imgName : '(生成失敗)',
        '',
        ''
      ]);

      logLine(`出力済み (${i + 1}/${total}): ${timeLabel}`);
    }

    // --- CSV 生成 ---
    setProgress('CSV・ZIP生成中...');
    await sleep(0);

    const csvContent = '\uFEFF' + // BOM
      csvRows.map(row => row.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    zip.file('detections.csv', csvContent);

    // --- ZIP 生成 & ダウンロード ---
    const zipBlob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } },
      (meta) => {
        setProgress(`ZIP圧縮中... ${meta.percent.toFixed(0)}%`);
      }
    );

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(zipBlob, `birdvoice_export_${stamp}.zip`);

    setProgress(`✅ 完了！ ${total}件を出力しました`);
    logLine(`全件出力完了: ${total}件 → birdvoice_export_${stamp}.zip`);

  } catch (e) {
    UI.exportProgress.className = 'error';
    setProgress(`❌ エラー: ${e?.message ?? e}`);
    logLine(`全件出力失敗: ${e?.message ?? e}`);
  } finally {
    UI.exportAllBtn.disabled = false;
  }
}

UI.exportAllBtn.addEventListener('click', exportAll);


wireScanSliders();

clearAll();
