const resultContainer = document.getElementById('resultContainer');
const fileInput = document.getElementById('audioFile');
const status = document.getElementById('status');

fileInput.addEventListener('change', async (e) = {
    const file = e.target.files[0];
    if (!file) return;

    status.textContent = 解析中...;
    resultContainer.innerHTML = ;

    const audioCtx = new (window.AudioContext  window.webkitAudioContext)();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const segmentDuration = 5;  5秒
    const overlap = 3;          3秒重複
    const step = segmentDuration - overlap;  次の開始位置までの歩進

    for (let start = 0; start  audioBuffer.duration - overlap; start += step) {
        createSpectrogram(audioBuffer, start, segmentDuration, audioCtx);
    }
    status.textContent = 解析完了;
});

async function createSpectrogram(buffer, startTime, duration, context) {
    const segmentCanvas = document.createElement('canvas');
    segmentCanvas.width = 600;
    segmentCanvas.height = 300;
    const ctx = segmentCanvas.getContext('2d');

     オフラインコンテキストで高速解析
    const offlineCtx = new OfflineAudioContext(1, context.sampleRate  duration, context.sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;

    const analyser = offlineCtx.createAnalyser();
    analyser.fftSize = 2048;  分解能
    source.connect(analyser);
    analyser.connect(offlineCtx.destination);

    source.start(0, startTime, duration);

     描画処理（簡易版ロジック）
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const sliceWidth = segmentCanvas.width  (duration  60);  1秒間を60フレームと想定

    let x = 0;
    source.onended = () = {
         実際の実装ではレンダリング中に定期的にanalyser.getByteFrequencyDataを取得してCanvasに描画します
    };

    const wrapper = document.createElement('div');
    wrapper.className = segment-wrapper;
    wrapper.innerHTML = `h3${startTime.toFixed(1)}s - ${(startTime + duration).toFixed(1)}sh3`;
    wrapper.appendChild(segmentCanvas);
    resultContainer.appendChild(wrapper);
    
     ※実用コードではレンダリングのタイミング制御が必要ですが、まずは枠組みとして提示します。
    offlineCtx.startRendering().then(renderedBuffer = {
         レンダリング完了後の処理
    });
}