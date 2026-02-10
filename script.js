const runBtn = document.getElementById('runBtn');
const fileInput = document.getElementById('audioFile');
const resultContainer = document.getElementById('resultContainer');
const status = document.getElementById('status');

let audioCtx = null;
let globalBuffer = null;

runBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return alert("ファイルを選択してください");

    // 【重要】ボタンクリックのタイミングでAudioContextを作成/再開する
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
    
    runBtn.disabled = true;
    status.textContent = "読み込み中...";
    resultContainer.innerHTML = "";

    try {
        const arrayBuffer = await file.arrayBuffer();
        status.textContent = "デコード中...";
        
        // ここで止まる場合は、ファイルが壊れているか形式が非対応の可能性があります
        globalBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        const duration = globalBuffer.duration;
        const segmentLen = 5; 
        const overlap = 3;    
        const step = segmentLen - overlap;

        status.textContent = "スペクトログラム生成中...";

        // 一気にループ回すとブラウザが固まるため、setTimeoutで処理を逃がす工夫
        for (let start = 0; start <= duration - segmentLen; start += step) {
            await new Promise(resolve => setTimeout(() => {
                createCard(start, segmentLen);
                resolve();
            }, 10)); // 10msずつ休憩を入れる
        }

        status.textContent = "完了！";
    } catch (e) {
        status.textContent = "エラー: " + e.message;
        console.error(e);
    }
    runBtn.disabled = false;
});

function createCard(startTime, duration) {
    const card = document.createElement('div');
    card.className = 'card'; // style.cssに合わせて調整してください
    
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 100;
    canvas.style.background = "#000";
    
    const playBtn = document.createElement('button');
    playBtn.textContent = startTime.toFixed(1) + "秒から再生";
    playBtn.onclick = () => {
        const src = audioCtx.createBufferSource();
        src.buffer = globalBuffer;
        src.connect(audioCtx.destination);
        src.start(0, startTime, duration);
    };

    card.appendChild(canvas);
    card.appendChild(playBtn);
    resultContainer.appendChild(card);

    drawWave(canvas, startTime, duration);
}

function drawWave(canvas, startTime, duration) {
    const ctx = canvas.getContext('2d');
    const data = globalBuffer.getChannelData(0);
    const sr = globalBuffer.sampleRate;
    const startIdx = Math.floor(startTime * sr);
    const endIdx = Math.floor((startTime + duration) * sr);

    const w = canvas.width;
    const h = canvas.height;
    const step = Math.floor((endIdx - startIdx) / w);

    ctx.fillStyle = "#0f0";
    for (let i = 0; i < w; i++) {
        let max = 0;
        for (let s = 0; s < step; s += 10) {
            const v = Math.abs(data[startIdx + (i * step) + s] || 0);
            if (v > max) max = v;
        }
        const barH = max * h * 2;
        ctx.fillRect(i, h - barH, 1, barH);
    }
}
