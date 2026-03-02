const apiGrid = document.getElementById("api-grid");
const waiting = document.getElementById("waiting");

let frameCount = 0;
let feedImg = null;
let counterEl = null;

function ensureFeed() {
  if (feedImg) return;

  const placeholder = apiGrid.querySelector(".no-feed");
  if (placeholder) placeholder.remove();
  waiting.style.display = "none";

  feedImg = document.createElement("img");
  feedImg.style.width = "100%";
  feedImg.style.display = "block";
  feedImg.style.borderRadius = "6px";
  apiGrid.appendChild(feedImg);

  counterEl = document.createElement("div");
  counterEl.style.cssText = "color:#666;font-size:11px;padding:4px 8px;";
  apiGrid.appendChild(counterEl);
}

if (window.recallBridge) {
  window.recallBridge.onMeetingDetected((data) => {
    console.log("[feed] Meeting:", data.platform);
    waiting.textContent = "Meeting detected — starting recording...";

    if (data.windowId) {
      window.recallBridge.startRecording(data.windowId);
    }
  });

  window.recallBridge.onVideoFrame((frame) => {
    const inner = frame.data || frame;
    const buffer = inner.buffer;
    if (!buffer) return;

    const participant = inner.participant || {};
    const name = participant.name || "Unknown";

    ensureFeed();
    frameCount++;
    feedImg.src = "data:image/png;base64," + buffer;
    counterEl.textContent = "Frame #" + frameCount + " | " + name + " | " + new Date().toLocaleTimeString();
  });

  window.recallBridge.onRecordingEnded(() => {
    feedImg = null;
    counterEl = null;
    frameCount = 0;
    apiGrid.innerHTML = '<div class="no-feed">No data yet</div>';
    waiting.style.display = "flex";
    waiting.textContent = "Recording ended";
  });
}
