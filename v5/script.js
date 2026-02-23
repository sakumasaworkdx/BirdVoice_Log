// BirdVoice_Log v5.2 (rollback+fix)

const threshold = document.getElementById("threshold");
const thVal = document.getElementById("thVal");
const maxSeconds = document.getElementById("maxSeconds");

const prepareBtn = document.getElementById("prepareBtn");
const scanBtn = document.getElementById("scanBtn");
const exportAllBtn = document.getElementById("exportAllBtn");

thVal.textContent = threshold.value;

// 感度スライダー表示＆保存
threshold.addEventListener("input", () => {
  if (threshold.value > 80) threshold.value = 80;
  thVal.textContent = threshold.value;
  localStorage.setItem("threshold", threshold.value);
});

// 保存値復元
window.addEventListener("load", () => {
  const t = localStorage.getItem("threshold");
  const s = localStorage.getItem("maxSeconds");

  if (t) {
    threshold.value = t;
    thVal.textContent = t;
  }

  if (s) maxSeconds.value = s;
});

// 秒上限制御
maxSeconds.addEventListener("change", () => {
  if (maxSeconds.value > 30) maxSeconds.value = 30;
  localStorage.setItem("maxSeconds", maxSeconds.value);
});

// 準備（例外でもUI復帰）
prepareBtn.onclick = async () => {
  try {
    prepareBtn.disabled = true;
    await new Promise(r => setTimeout(r, 300));
    alert("準備完了");
  } finally {
    prepareBtn.disabled = false;
  }
};

// スキャン（UI動作確認用）
scanBtn.onclick = () => {
  const list = document.getElementById("list");
  list.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = "検出テスト OK";
  list.appendChild(li);
};

// ZIP出力（ダミー）
exportAllBtn.onclick = () => {
  alert("ZIP出力（準備中）");
};
