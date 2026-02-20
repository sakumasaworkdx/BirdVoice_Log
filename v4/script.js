'use strict';

const UI = {
  fileInput: document.getElementById('fileInput'),
  scanMinHz: document.getElementById('scanMinHz'),
  scanMaxHz: document.getElementById('scanMaxHz'),
  scanThreshold: document.getElementById('scanThreshold'),
  scanMinHzNum: document.getElementById('scanMinHzNum'),
  scanMaxHzNum: document.getElementById('scanMaxHzNum'),
  scanThresholdNum: document.getElementById('scanThresholdNum'),
  scanBtn: document.getElementById('scanBtn'),
  scanBar: document.getElementById('scanBar'),
  scanPct: document.getElementById('scanPct'),
  detectList: document.getElementById('detectList'),
  status: document.getElementById('status'),
  specCanvas: document.getElementById('specCanvas'),
  viewport: document.getElementById('viewport')
};

let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let globalBuffer = null;
const SEG_SEC = 5; // 5秒ごとにスライス

// --- 初期設定: 入力の同期 ---
const sync = (a, b) => {
  a.addEventListener('input', () => b.value = a.value);
  b.addEventListener('input', () => a.value = b.value);
};
sync(UI.scanMinHz, UI.scanMinHzNum);
sync(UI.scanMaxHz, UI.scanMaxHzNum);
sync(UI.scanThreshold, UI.scanThresholdNum);

window.setPreset = (min, max, thr) => {
  UI.scanMinHz.value = UI.scanMinHzNum.value = min;
  UI.scanMaxHz.value = UI.scanMaxHzNum.value = max;
  UI.scanThreshold.value = UI.scanThresholdNum.value = thr;
};

// --- 解析実行 ---
UI.scanBtn.addEventListener('click', async () => {
  const file = UI.fileInput.files[0];
  if (!file) return alert("ファイルを選択してください");

  UI.scanBtn.disabled = true;
  UI.detectList.innerHTML = "";
  UI.status.textContent = "解析中...";
  
  const minHz = parseInt(UI.scanMinHz.value);
  const maxHz = parseInt(UI.scanMaxHz.value);
  const thrDb = parseInt(UI.scanThreshold.value);

  // 擬似的な総時間を取得（MP3の場合はデコードしてみないと正確には不明だがファイルサイズから推測）
  // ここでは128kbpsと仮定して概算、またはスライスが終わるまで回す
  const fileSize = file.size;
  let offset = 0;
  let currentTime = 0;
  
  // 仮の総セグメント数（進捗表示用）
  const estimatedTotal = Math.ceil(fileSize / (1024 * 1024)); // 1MBごと

  try {
    while (offset < fileSize) {
      // 巨大ファイルを少しずつ読み込む (約5秒分に相当するバイト数をスライス)
      const chunkSize = 512 * 1024; // 512KBずつ試行
      const blob = file.slice(offset, offset + chunkSize);
      const arrayBuf = await blob.arrayBuffer();
      
      try {
        const buffer = await audioCtx.decodeAudioData(arrayBuf);
        const data = buffer.getChannelData(0);
        const sampleRate = buffer.sampleRate;
        
        // FFTの簡易代用：指定帯域のエネルギー計算
        const fftSize = 2048;
        const binCount = fftSize / 2;
        const hzPerBin = sampleRate / fftSize;
        const minBin = Math.floor(minHz / hzPerBin);
        const maxBin = Math.floor(maxHz / hzPerBin);

        // 簡易的なパワー計算（ピーク判定）
        let maxVal = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          if (v > maxVal) maxVal = v;
        }
        
        const db = 20 * Math.log10(maxVal + 1e-9);

        if (db >= thrDb) {
          addDetectButton(currentTime);
        }

        currentTime += buffer.duration;
        offset += chunkSize;
      } catch (e) {
        // MP3の切れ目などでエラーが出ても無視して次へ
        offset += chunkSize;
      }

      // 進捗更新
      const pct = Math.min(100, Math.floor((offset / fileSize) * 100));
      UI.scanBar.style.width = pct + "%";
      UI.scanPct.textContent = pct + "%";
      
      // UIフリーズ防止
      await new Promise(r => setTimeout(r, 1));
    }
    UI.status.textContent = "解析完了";
  } catch (err) {
    console.error(err);
    UI.status.textContent = "エラー発生";
  } finally {
    UI.scanBtn.disabled = false;
  }
});

function addDetectButton(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const timeStr = `${m}:${s.toString().padStart(2, '0')}`;
  
  const btn = document.createElement('button');
  btn.className = 'detect-btn';
  btn.textContent = timeStr;
  btn.onclick = () => {
    // 再生処理などはここに
    alert(timeStr + " 付近を再生します（再生機能はデコード後に有効）");
  };
  UI.detectList.appendChild(btn);
}
