async function startAnalysis() {
    const file = document.getElementById('audioFile').files[0];
    if (!file) return alert("ファイルを選んでください");

    const status = document.getElementById('status');
    const result = document.getElementById('result');
    status.innerText = "読み込み開始...";

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        status.innerText = "デコード中（ここが一番時間がかかります）...";
        
        // 巨大なファイルを扱った後はここが詰まりやすいため、
        // 失敗した場合はブラウザのタブを一度閉じてやり直してください
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        status.innerText = "描画中...";
        result.innerHTML = "";

        const data = audioBuffer.getChannelData(0);
        const sr = audioBuffer.sampleRate;
        const segmentSamples = 5 * sr; // 5秒
        
        for (let i = 0; i < audioBuffer.duration; i += 2) {
            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 80;
            canvas.style.background = "#000";
            canvas.style.margin = "5px";
            result.appendChild(canvas);

            const ctx = canvas.getContext('2d');
            const startIdx = Math.floor(i * sr);
            
            // 高速に描画するための間引き処理
            ctx.fillStyle = "#0f0";
            for (let x = 0; x < canvas.width; x++) {
                const idx = startIdx + Math.floor(x * (segmentSamples / canvas.width));
                const val = Math.abs(data[idx] || 0) * canvas.height;
                ctx.fillRect(x, canvas.height - val, 1, val);
            }
        }
        status.innerText = "完了！";
    } catch (e) {
        status.innerText = "エラー: " + e.message;
        console.error(e);
    }
}
