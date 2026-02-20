
// MP3 & WAV band scanner using Web Audio decodeAudioData
// Supports large files via 5s slicing and sequential decoding

const fileInput = document.getElementById("file");
const startBtn = document.getElementById("scanBtn");
const stopBtn = document.getElementById("stopBtn");
const progress = document.getElementById("progress");
const results = document.getElementById("results");
const minHz = document.getElementById("minHz");
const maxHz = document.getElementById("maxHz");
const threshold = document.getElementById("threshold");

let audioCtx;
let scanning = false;
let detectedTimes = [];
let audioBufferFull = null;

function formatTime(sec){
  const h = String(Math.floor(sec/3600)).padStart(2,"0");
  const m = String(Math.floor(sec%3600/60)).padStart(2,"0");
  const s = String(Math.floor(sec%60)).padStart(2,"0");
  return `${h}:${m}:${s}`;
}

async function decodeSlice(file, start, end){
  const slice = file.slice(start, end);
  const arrayBuffer = await slice.arrayBuffer();
  return await audioCtx.decodeAudioData(arrayBuffer);
}

function analyzeSegment(buffer, startTime){
  const channelData = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  const freqData = new Float32Array(analyser.frequencyBinCount);

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(analyser);
  analyser.connect(audioCtx.destination);

  src.start();

  analyser.getFloatFrequencyData(freqData);

  const hzPerBin = sampleRate / analyser.fftSize;
  const minIndex = Math.floor(minHz.value / hzPerBin);
  const maxIndex = Math.floor(maxHz.value / hzPerBin);

  let energy = 0;
  for(let i=minIndex;i<=maxIndex;i++){
    energy += freqData[i];
  }

  src.stop();

  if(energy > threshold.value){
    detectedTimes.push(Math.floor(startTime));
  }
}

async function scanFile(file){
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  scanning = true;
  detectedTimes = [];
  results.innerHTML = "";

  const durationEstimate = 5; // seconds per segment
  const chunkSize = 1024 * 1024 * 5; // 5MB chunk read

  let offset = 0;
  let segmentIndex = 0;

  while(offset < file.size && scanning){
    const buffer = await decodeSlice(file, offset, offset + chunkSize);

    analyzeSegment(buffer, segmentIndex * durationEstimate);

    offset += chunkSize;
    segmentIndex++;

    progress.value = (offset / file.size) * 100;
    await new Promise(r=>setTimeout(r,10));
  }

  scanning = false;
  showResults(file);
}

function showResults(file){
  const unique = [...new Set(detectedTimes)];
  unique.forEach(sec=>{
    const btn = document.createElement("button");
    btn.textContent = formatTime(sec);
    btn.onclick = ()=>playAt(file, sec);
    results.appendChild(btn);
  });
}

async function playAt(file, time){
  if(!audioBufferFull){
    const arrayBuffer = await file.arrayBuffer();
    audioBufferFull = await audioCtx.decodeAudioData(arrayBuffer);
  }
  const src = audioCtx.createBufferSource();
  src.buffer = audioBufferFull;
  src.connect(audioCtx.destination);
  src.start(0, time);
}

startBtn.onclick = () => {
  const file = fileInput.files[0];
  if(!file) return alert("ファイルを選択してください");
  scanFile(file);
};

stopBtn.onclick = () => scanning = false;
