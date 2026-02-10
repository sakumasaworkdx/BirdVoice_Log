const runBtn = document.getElementById('runBtn');
const fileInput = document.getElementById('audioFile');
const resultContainer = document.getElementById('resultContainer');
const status = document.getElementById('status');
let audioCtx, globalBuffer;

runBtn.addEventListener('click', async () => {
const file = fileInput.files[0];
if (!file) return;
if (!audioCtx) audioCtx = new AudioContext();
status.textContent = "解析中...";
resultContainer.innerHTML = "";
const arrayBuffer = await file.arrayBuffer();
globalBuffer = await audioCtx.decodeAudioData(arrayBuffer);

});

function drawSpec(canvas, start) {
const ctx = canvas.getContext('2d');
const data = globalBuffer.getChannelData(0);
const sr = globalBuffer.sampleRate;
const startIdx = Math.floor(start * sr);
const w = canvas.width;
const h = canvas.height;
for (let i = 0; i < w; i++) {
const v = Math.abs(data[startIdx + i * 100] || 0);
ctx.fillStyle = "hsl(" + (240 - v * 500) + ", 100%, 50%)";
ctx.fillRect(i, h - v * h * 5, 1, v * h * 5);
}
}
