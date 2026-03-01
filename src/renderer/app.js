console.log("[renderer] app.js loaded");

const status = document.getElementById("status");
const meetingInfo = document.getElementById("meeting-info");
const btnRecord = document.getElementById("btn-record");
const btnStop = document.getElementById("btn-stop");
const videoGrid = document.getElementById("video-grid");
const transcript = document.getElementById("transcript");

let currentWindowId = null;

// Track video tiles per participant
const videoTiles = new Map();

function getOrCreateTile(participantId, participantName) {
  if (videoTiles.has(participantId)) {
    return videoTiles.get(participantId);
  }

  // Remove "no video" placeholder
  const placeholder = videoGrid.querySelector(".no-video");
  if (placeholder) placeholder.remove();

  const tile = document.createElement("div");
  tile.className = "video-tile";

  const img = document.createElement("img");
  img.alt = participantName || "Participant";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = participantName || "Participant " + (videoTiles.size + 1);

  tile.appendChild(img);
  tile.appendChild(name);
  videoGrid.appendChild(tile);

  const entry = { tile, img, name };
  videoTiles.set(participantId, entry);
  return entry;
}

if (!window.recallBridge) {
  status.textContent = "ERROR: preload bridge not available";
} else {
  status.textContent = "Bridge OK — waiting for a meeting...";

  window.recallBridge.onMeetingDetected((data) => {
    console.log("[renderer] Meeting detected:", data);
    currentWindowId = data.windowId;
    status.textContent = "Meeting detected!";
    meetingInfo.style.display = "block";
    meetingInfo.textContent = data.title || "Meeting";
    btnRecord.disabled = false;
  });

  window.recallBridge.onSdkStateChange((data) => {
    console.log("[renderer] SDK state:", data);
  });

  window.recallBridge.onRecordingEnded((data) => {
    console.log("[renderer] Recording ended:", data);
    status.textContent = "Recording ended: " + (data.reason || "stopped");
    btnStop.disabled = true;
    if (currentWindowId) {
      btnRecord.disabled = false;
    }
  });

  window.recallBridge.onVideoFrame((frame) => {
    // frame = { data: { buffer, timestamp }, video_separate: { id, participant }, recording, bot }
    const inner = frame.data || frame;
    const buffer = inner.buffer;
    if (!buffer) return;

    const vs = frame.video_separate || {};
    const participant = vs.participant || {};
    const participantId = participant.id || vs.id || "unknown";
    const participantName = participant.name || null;

    const entry = getOrCreateTile(participantId, participantName);
    entry.img.src = "data:image/png;base64," + buffer;

    if (participantName && entry.name.textContent !== participantName) {
      entry.name.textContent = participantName;
    }
  });

  window.recallBridge.onTranscriptData((data) => {
    const line = document.createElement("div");
    line.className = "transcript-line";
    const speaker = data.speaker || "Unknown";
    const text = data.text || data.transcript || JSON.stringify(data);
    line.innerHTML = '<span class="speaker">' + speaker + ':</span> ' + text;
    transcript.appendChild(line);
    transcript.scrollTop = transcript.scrollHeight;
  });
}

btnRecord.addEventListener("click", async () => {
  if (!currentWindowId) return;
  btnRecord.disabled = true;
  status.textContent = "Starting recording...";
  const result = await window.recallBridge.startRecording(currentWindowId);
  if (result.ok) {
    status.textContent = "Recording in progress";
    btnStop.disabled = false;
  } else {
    status.textContent = "Error: " + result.error;
    btnRecord.disabled = false;
  }
});

btnStop.addEventListener("click", async () => {
  btnStop.disabled = true;
  status.textContent = "Stopping...";
  await window.recallBridge.stopRecording();
  status.textContent = "Recording stopped";
  if (currentWindowId) {
    btnRecord.disabled = false;
  }
});
