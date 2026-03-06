// ── DOM references ────────────────────────────────────────────────────
const meetingUrlInput = document.getElementById("meeting-url");
const namePrefixInput = document.getElementById("name-prefix");
const botCountSelect = document.getElementById("bot-count");
const btnDeploy = document.getElementById("btn-deploy");
// btnBroadcast removed from UI
const btnRemoveAll = document.getElementById("btn-remove-all");
const statusBar = document.getElementById("status-bar");
const botGrid = document.getElementById("bot-grid");
const emptyState = document.getElementById("empty-state");

// Modal
const sendModal = document.getElementById("send-modal");
const modalTitle = document.getElementById("modal-title");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const modalCancel = document.getElementById("modal-cancel");
const modalSend = document.getElementById("modal-send");

// Stream panel
const streamPanel = document.getElementById("stream-panel");
const streamVideo = document.getElementById("stream-video");
const streamCanvas = document.getElementById("stream-canvas");
const streamImage = document.getElementById("stream-image");
const previewPlaceholder = document.getElementById("preview-placeholder");
const streamInfo = document.getElementById("stream-info");
const btnForceRemove = document.getElementById("btn-force-remove");

// Output feature controls
const cameraSource = document.getElementById("camera-source");
const toggleCamera = document.getElementById("toggle-camera");
const indCamera = document.getElementById("ind-camera");
const btnPickImage = document.getElementById("btn-pick-image");
const toggleImage = document.getElementById("toggle-image");
const indImage = document.getElementById("ind-image");
const btnPickVideo = document.getElementById("btn-pick-video");
const videoFileInput = document.getElementById("video-file-input");
const toggleVideo = document.getElementById("toggle-video");
const indVideo = document.getElementById("ind-video");
const btnPickMusic = document.getElementById("btn-pick-music");
const musicFileInput = document.getElementById("music-file-input");
const toggleMusic = document.getElementById("toggle-music");
const indMusic = document.getElementById("ind-music");
const urlInput = document.getElementById("url-input");
const toggleUrl = document.getElementById("toggle-url");
const indUrl = document.getElementById("ind-url");
const toggleAudio = document.getElementById("toggle-audio");
const indAudio = document.getElementById("ind-audio");

// Feature row containers (clickable)
const rowCamera = document.getElementById("row-camera");
const rowUrl = document.getElementById("row-url");
const rowAudio = document.getElementById("row-audio");
const rowImage = document.getElementById("row-image");
const rowVideo = document.getElementById("row-video");
const rowMusic = document.getElementById("row-music");
const imageFileName = document.getElementById("image-file-name");
const videoFileName = document.getElementById("video-file-name");
const musicFileName = document.getElementById("music-file-name");

// Settings modal
const btnSettings = document.getElementById("btn-settings");
const settingsModal = document.getElementById("settings-modal");
const settingsProvider = document.getElementById("settings-provider");
const deepgramHint = document.getElementById("deepgram-hint");
const settingsCancel = document.getElementById("settings-cancel");
const settingsSave = document.getElementById("settings-save");

let activeBots = [];
let pollInterval = null;
let modalTargetBotId = null; // null = broadcast
let pendingImageB64 = null;

// Streaming state
let videoStream = null;
let videoFrameInterval = null;
let audioStream = null;
let audioRecorder = null;
let audioChunkInterval = null;
let framesSent = 0;
let framesErrors = 0;
let isSendingFrame = false;

// Output Media mode (30fps via ngrok webpage vs 5fps via API)
let outputMediaMode = false;
let pushSocket = null; // Direct WebSocket to server for frame pushing
let audioSocket = null; // WebSocket for gapless audio streaming
let videoSocket = null; // WebSocket for gapless video streaming

// Video file state
let videoFileUrl = null; // blob URL for local preview
let videoUploaded = false;

// Music file state
let musicUploaded = false;

// Global lock: prevents concurrent toggle operations
let outputToggleBusy = false;

const bridge = window.recallBridge;

// ── Speaker avatar helpers ──────────────────────────────────────────
const AVATAR_COLORS = [
  "#4f8eff", "#00cc6a", "#ff9f43", "#ff6b6b", "#a55eea",
  "#2ed573", "#ffa502", "#ff4757", "#1e90ff", "#ff6348",
];

function speakerColor(name) {
  if (!name) return "#666";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function speakerInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
}

function createAvatarElement(name) {
  const avatar = document.createElement("span");
  avatar.className = "speaker-avatar";
  avatar.style.background = speakerColor(name);
  avatar.textContent = speakerInitials(name);
  return avatar;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Preview management ───────────────────────────────────────────────
// Shows the correct preview element based on active output type
function showPreview(type) {
  streamVideo.classList.remove("active");
  streamImage.classList.remove("active");
  previewPlaceholder.classList.remove("hidden");

  if (type === "camera" || type === "video") {
    streamVideo.classList.add("active");
    previewPlaceholder.classList.add("hidden");
  } else if (type === "image") {
    streamImage.classList.add("active");
    previewPlaceholder.classList.add("hidden");
  } else if (type === "none") {
    // Show placeholder
  }
}

// ── Drag-and-drop on preview area ────────────────────────────────────
const streamPreview = document.querySelector(".stream-preview");

streamPreview.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  streamPreview.style.outline = "2px solid #4f8eff";
  streamPreview.style.outlineOffset = "-2px";
});

streamPreview.addEventListener("dragleave", (e) => {
  e.preventDefault();
  streamPreview.style.outline = "";
  streamPreview.style.outlineOffset = "";
});

streamPreview.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  streamPreview.style.outline = "";
  streamPreview.style.outlineOffset = "";

  const file = e.dataTransfer?.files?.[0];
  if (!file) return;

  const type = file.type || "";

  if (type.startsWith("image/")) {
    // ── Image drop: load, broadcast, and activate ──
    if (outputToggleBusy) return;
    const dn = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
    imageFileName.textContent = dn;
    imageFileName.style.color = "#ccc";
    outputToggleBusy = true;
    deactivateAllOutputs();
    toggleImage.classList.add("on", "busy");

    // Load image into base64 via canvas (reuse existing logic)
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const img = new Image();
      img.onload = async () => {
        const hiRes = document.createElement("canvas");
        hiRes.width = 2560; hiRes.height = 1440;
        const hiCtx = hiRes.getContext("2d");
        hiCtx.fillStyle = "#000";
        hiCtx.fillRect(0, 0, 2560, 1440);
        const scale = Math.min(2560 / img.width, 1440 / img.height);
        const w = img.width * scale, h = img.height * scale;
        hiCtx.drawImage(img, (2560 - w) / 2, (1440 - h) / 2, w, h);
        const canvas = document.createElement("canvas");
        canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(hiRes, 0, 0, 1280, 720);
        pendingImageB64 = canvas.toDataURL("image/jpeg", 0.95).split(",")[1];

        try {
          await bridge.deactivateOutputMedia().catch(() => {});
          const result = await bridge.broadcastImage(pendingImageB64);
          if (result.error) throw new Error(result.error);
          streamImage.src = `data:image/jpeg;base64,${pendingImageB64}`;
          showPreview("image");
          indImage.classList.add("active");
          statusBar.textContent = `Image sent to ${result.sent} bot(s)`;
        } catch (err) {
          toggleImage.classList.remove("on");
          indImage.classList.remove("active");
          statusBar.textContent = `Image failed: ${err.message}`;
        } finally {
          toggleImage.classList.remove("busy");
          outputToggleBusy = false;
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);

  } else if (type.startsWith("video/")) {
    // ── Video drop: upload and activate ──
    if (outputToggleBusy) return;
    const vdn = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
    videoFileName.textContent = vdn;
    videoFileName.style.color = "#ccc";
    statusBar.textContent = "Uploading video...";
    try {
      const buffer = await file.arrayBuffer();
      const result = await bridge.uploadVideo(file.name, buffer);
      if (result.error) { statusBar.textContent = `Video upload failed: ${result.error}`; return; }

      if (videoFileUrl) URL.revokeObjectURL(videoFileUrl);
      videoFileUrl = URL.createObjectURL(file);
      videoUploaded = true;
      btnPickVideo.textContent = vdn;
      statusBar.textContent = `Video uploaded: ${file.name}`;

      // Auto-activate
      outputToggleBusy = true;
      deactivateAllOutputs();
      toggleVideo.classList.add("on", "busy");
      try {
        await activateVideoOutput();
      } catch (err) {
        toggleVideo.classList.remove("on");
        indVideo.classList.remove("active");
        statusBar.textContent = `Video failed: ${err.message}`;
      } finally {
        toggleVideo.classList.remove("busy");
        outputToggleBusy = false;
      }
    } catch (err) {
      statusBar.textContent = `Video upload failed: ${err.message}`;
    }

  } else if (type.startsWith("audio/")) {
    // ── Audio/Music drop: upload and activate ──
    if (outputToggleBusy) return;
    const mdn = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
    musicFileName.textContent = mdn;
    musicFileName.style.color = "#ccc";
    statusBar.textContent = "Uploading music...";
    try {
      const buffer = await file.arrayBuffer();
      const result = await bridge.uploadMusic(file.name, buffer);
      if (result.error) { statusBar.textContent = `Music upload failed: ${result.error}`; return; }

      musicUploaded = true;
      btnPickMusic.textContent = mdn;
      statusBar.textContent = `Music uploaded: ${file.name}`;

      // Auto-activate
      outputToggleBusy = true;
      deactivateAllOutputs();
      toggleMusic.classList.add("on", "busy");
      try {
        await activateMusicOutput();
      } catch (err) {
        toggleMusic.classList.remove("on");
        indMusic.classList.remove("active");
        statusBar.textContent = `Music failed: ${err.message}`;
      } finally {
        toggleMusic.classList.remove("busy");
        outputToggleBusy = false;
      }
    } catch (err) {
      statusBar.textContent = `Music upload failed: ${err.message}`;
    }

  } else {
    statusBar.textContent = `Unsupported file type: ${type || "unknown"}`;
  }
});

// ── Check tunnel status ──────────────────────────────────────────────
async function checkNgrokStatus() {
  try {
    const status = await bridge.getNgrokStatus();
    outputMediaMode = status.available;
    updateStreamInfo();
  } catch {
    outputMediaMode = false;
  }
  // Always connect push socket for direct frame delivery
  if (!pushSocket) connectPushSocket();
}

function connectPushSocket() {
  if (pushSocket) return;
  pushSocket = new WebSocket("ws://localhost:3000/ws/frame-push");
  pushSocket.binaryType = "arraybuffer";
  pushSocket.onopen = () => console.log("[ws] Frame push socket connected");
  pushSocket.onclose = () => {
    pushSocket = null;
    // Reconnect if still in output media mode
    if (outputMediaMode) setTimeout(connectPushSocket, 2000);
  };
  pushSocket.onerror = () => pushSocket?.close();
}

// ── Real-time transcript WebSocket ────────────────────────────────────
let transcriptSocket = null;

function connectTranscriptSocket() {
  if (transcriptSocket) return;
  transcriptSocket = new WebSocket("ws://localhost:3000/ws/transcript");
  transcriptSocket.onopen = () => console.log("[ws] Transcript socket connected");
  transcriptSocket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const el = document.getElementById(`transcript-${data.botId}`);
      if (!el) return;

      // Mark this bot as receiving real-time data (skip poll fallback)
      el.dataset.realtime = "1";

      // Clear "Listening..." placeholder on first real data
      if (!el.dataset.hasData) {
        el.innerHTML = "";
        el.dataset.hasData = "1";
      }

      if (data.is_final) {
        const partial = el.querySelector(".partial");
        if (partial) partial.remove();

        const line = document.createElement("div");
        line.className = "transcript-line";
        if (data.speaker) {
          line.appendChild(createAvatarElement(data.speaker));
          const textWrap = document.createElement("span");
          textWrap.className = "transcript-line-text";
          const speakerSpan = document.createElement("span");
          speakerSpan.className = "speaker";
          speakerSpan.textContent = data.speaker + ": ";
          textWrap.appendChild(speakerSpan);
          textWrap.appendChild(document.createTextNode(data.text));
          line.appendChild(textWrap);
        } else {
          line.textContent = data.text;
        }
        el.appendChild(line);
      } else {
        let partial = el.querySelector(".partial");
        if (!partial) {
          partial = document.createElement("div");
          partial.className = "partial transcript-line";
          partial.style.color = "#666";
          partial.style.fontStyle = "italic";
          el.appendChild(partial);
        }
        partial.innerHTML = "";
        if (data.speaker) {
          partial.appendChild(createAvatarElement(data.speaker));
          const textSpan = document.createElement("span");
          textSpan.className = "transcript-line-text";
          textSpan.textContent = data.speaker + ": " + data.text;
          partial.appendChild(textSpan);
        } else {
          partial.textContent = data.text;
        }
      }

      // Keep only last 20 final lines
      const finals = el.querySelectorAll(".transcript-line:not(.partial)");
      while (finals.length > 20) el.removeChild(finals[0]);
      el.scrollTop = el.scrollHeight;
    } catch {}
  };
  transcriptSocket.onclose = () => {
    transcriptSocket = null;
    setTimeout(connectTranscriptSocket, 3000);
  };
  transcriptSocket.onerror = () => transcriptSocket?.close();
}

connectTranscriptSocket();
checkNgrokStatus();


// ── Listen for toggle state changes ───────────────────────────────────
if (bridge.onToggleState) {
  bridge.onToggleState((toggles) => {
    const disabled = !toggles.botFleet;
    btnDeploy.disabled = disabled;
    if (disabled) {
      statusBar.textContent = "Bot Fleet is OFF — enable it with the toggle above";
      // Stop streams if running
      if (videoStream) stopCamera();
      if (audioRecorder) stopAudioStream();
    }
  });
  // Check initial state
  bridge.getToggles().then((toggles) => {
    if (!toggles.botFleet) {
      btnDeploy.disabled = true;
      statusBar.textContent = "Bot Fleet is OFF — enable it with the toggle above";
    }
  });
}

// ── URL history ──────────────────────────────────────────────────────
const urlHistoryEl = document.getElementById("url-history");
const URL_HISTORY_KEY = "meetingUrlHistory";
const MAX_URL_HISTORY = 10;

function getUrlHistory() {
  try { return JSON.parse(localStorage.getItem(URL_HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function saveUrlToHistory(url) {
  let history = getUrlHistory().filter((u) => u !== url);
  history.unshift(url);
  if (history.length > MAX_URL_HISTORY) history = history.slice(0, MAX_URL_HISTORY);
  localStorage.setItem(URL_HISTORY_KEY, JSON.stringify(history));
}

function removeUrlFromHistory(url) {
  const history = getUrlHistory().filter((u) => u !== url);
  localStorage.setItem(URL_HISTORY_KEY, JSON.stringify(history));
  renderUrlHistory();
}

function renderUrlHistory() {
  const history = getUrlHistory();
  if (history.length === 0) {
    urlHistoryEl.classList.remove("open");
    return;
  }
  urlHistoryEl.innerHTML = history.map((url) =>
    `<div class="url-history-item" data-url="${escapeHtml(url)}">
      <span class="url-text">${escapeHtml(url)}</span>
      <span class="url-remove" data-remove="${escapeHtml(url)}">&times;</span>
    </div>`
  ).join("");
  urlHistoryEl.classList.add("open");
}

meetingUrlInput.addEventListener("focus", () => {
  if (getUrlHistory().length > 0) renderUrlHistory();
});

meetingUrlInput.addEventListener("input", () => {
  const val = meetingUrlInput.value.trim().toLowerCase();
  const history = getUrlHistory();
  const filtered = val ? history.filter((u) => u.toLowerCase().includes(val)) : history;
  if (filtered.length === 0) {
    urlHistoryEl.classList.remove("open");
    return;
  }
  urlHistoryEl.innerHTML = filtered.map((url) =>
    `<div class="url-history-item" data-url="${escapeHtml(url)}">
      <span class="url-text">${escapeHtml(url)}</span>
      <span class="url-remove" data-remove="${escapeHtml(url)}">&times;</span>
    </div>`
  ).join("");
  urlHistoryEl.classList.add("open");
});

urlHistoryEl.addEventListener("click", (e) => {
  const removeBtn = e.target.closest("[data-remove]");
  if (removeBtn) {
    e.stopPropagation();
    removeUrlFromHistory(removeBtn.dataset.remove);
    return;
  }
  const item = e.target.closest(".url-history-item");
  if (item) {
    meetingUrlInput.value = item.dataset.url;
    urlHistoryEl.classList.remove("open");
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".url-wrap")) urlHistoryEl.classList.remove("open");
});

// Restore last used URL on load
const lastHistory = getUrlHistory();
if (lastHistory.length > 0 && !meetingUrlInput.value) {
  meetingUrlInput.value = lastHistory[0];
}

// ── Deploy ────────────────────────────────────────────────────────────
btnDeploy.addEventListener("click", async () => {
  const meetingUrl = meetingUrlInput.value.trim();
  if (!meetingUrl) {
    meetingUrlInput.focus();
    return;
  }

  saveUrlToHistory(meetingUrl);
  urlHistoryEl.classList.remove("open");

  const botCount = parseInt(botCountSelect.value, 10);
  const namePrefix = namePrefixInput.value.trim() || "Assistant";

  btnDeploy.disabled = true;
  btnDeploy.textContent = "Adding...";
  statusBar.textContent = `Deploying ${botCount} bot(s)...`;

  try {
    const result = await bridge.deployBots(meetingUrl, botCount, namePrefix);

    if (result.error) {
      statusBar.textContent = `Error: ${result.error}`;
      return;
    }

    const newBots = result.created || [];
    // Merge new bots into existing list (additive deploy)
    const existingIds = new Set(activeBots.map((b) => b.id));
    for (const bot of newBots) {
      if (!existingIds.has(bot.id)) activeBots.push(bot);
    }
    outputMediaMode = result.mode === "webpage";
    const modeLabel = outputMediaMode ? "Webpage 30fps" : "API 5fps";
    if (result.errors?.length && newBots.length === 0) {
      statusBar.textContent = `Deploy failed: ${result.errors[0].error}`;
    } else {
      statusBar.textContent =
        `Added ${newBots.length} bot(s) [${modeLabel}], ${activeBots.length} total` +
        (result.errors?.length ? ` (${result.errors.length} failed: ${result.errors[0].error})` : "");
    }

    renderBots();

    startPolling();
    btnRemoveAll.disabled = false;
  } catch (err) {
    statusBar.textContent = `Deploy failed: ${err.message}`;
  } finally {
    btnDeploy.disabled = false;
    btnDeploy.textContent = "Add Bots";
  }
});

// ── Remove All ────────────────────────────────────────────────────────
btnRemoveAll.addEventListener("click", async () => {
  btnRemoveAll.disabled = true;
  statusBar.textContent = "Removing all bots...";

  try {
    await deactivateAllOutputsAndApi();
    await bridge.removeAllBots();
    // Re-fetch bots from server — they persist with transcripts, just marked as leaving/done
    const bots = await bridge.listBots();
    if (Array.isArray(bots)) {
      activeBots = bots;
      renderBots();
    }
    // Keep polling so bots transition from "leaving" → "done" in the UI
    // Polling will show updated status dots

    statusBar.textContent = "All bots told to leave — transcripts preserved";
  } catch (err) {
    statusBar.textContent = `Remove failed: ${err.message}`;
  } finally {
    btnRemoveAll.disabled = false;
  }
});

// ── Force Remove All (queries Recall API directly) ────────────────────
btnForceRemove.addEventListener("click", async () => {
  btnForceRemove.disabled = true;
  btnForceRemove.textContent = "Killing...";
  statusBar.textContent = "Force removing ALL bots from Recall.ai...";

  try {
    await deactivateAllOutputsAndApi();
    const result = await bridge.forceRemoveAllBots();
    stopPolling();
    activeBots = [];
    renderBots();

    btnRemoveAll.disabled = true;

    statusBar.textContent = result.error
      ? `Error: ${result.error}`
      : `Force removed ${result.total} bot(s)`;
  } catch (err) {
    statusBar.textContent = `Force remove failed: ${err.message}`;
  } finally {
    btnForceRemove.disabled = false;
    btnForceRemove.textContent = "Force Kill All Bots";
  }
});

// ── New Session ───────────────────────────────────────────────────────
const btnNewSession = document.getElementById("btn-new-session");
btnNewSession.addEventListener("click", async () => {
  if (!confirm("Start a new session? This will remove all bots and clear all state.")) return;
  btnNewSession.disabled = true;
  statusBar.textContent = "Resetting session...";

  try {
    await bridge.resetSession();
    stopPolling();
    activeBots = [];
    renderBots();
    statusBar.textContent = "New session started";
    btnRemoveAll.disabled = true;
  } catch (err) {
    statusBar.textContent = `Session reset failed: ${err.message}`;
  } finally {
    btnNewSession.disabled = false;
  }
});

// ── Broadcast ─────────────────────────────────────────────────────────
// Broadcast via Image feature row now

// ── Image Modal ───────────────────────────────────────────────────────
function openModal() {
  pendingImageB64 = null;
  dropZone.innerHTML = "Drop image here or click to browse";
  modalSend.disabled = true;
  sendModal.classList.add("active");
}

function closeModal() {
  sendModal.classList.remove("active");
  modalTargetBotId = null;
  pendingImageB64 = null;
}

modalCancel.addEventListener("click", closeModal);
sendModal.addEventListener("click", (e) => {
  if (e.target === sendModal) closeModal();
});

dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) loadImageFile(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadImageFile(file, true);
  fileInput.value = "";
});

function loadImageFile(file, autoActivate = false) {
  if (!file.type.startsWith("image/")) return;

  const displayName = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
  imageFileName.textContent = displayName;
  imageFileName.style.color = "#ccc";

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    // Show preview in modal if open
    dropZone.innerHTML = `<img src="${dataUrl}" />`;

    // Convert to JPEG base64 via canvas
    const img = new Image();
    img.onload = () => {
      // Supersample: render at 2x then downscale for sharpest result
      const hiRes = document.createElement("canvas");
      hiRes.width = 2560;
      hiRes.height = 1440;
      const hiCtx = hiRes.getContext("2d");

      hiCtx.fillStyle = "#000";
      hiCtx.fillRect(0, 0, 2560, 1440);

      const scale = Math.min(2560 / img.width, 1440 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      hiCtx.drawImage(img, (2560 - w) / 2, (1440 - h) / 2, w, h);

      // Downscale to 1280x720 with high-quality interpolation
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(hiRes, 0, 0, 1280, 720);

      // JPEG quality 0.95 — max recommended by Recall (1.3MB limit)
      const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.95);
      pendingImageB64 = jpegDataUrl.split(",")[1];
      modalSend.disabled = false;

      // Auto-activate: broadcast immediately after picking from row click
      if (autoActivate && !outputToggleBusy) {
        outputToggleBusy = true;
        deactivateAllOutputs();
        toggleImage.classList.add("on", "busy");
        (async () => {
          try {
            await bridge.deactivateOutputMedia().catch(() => {});
            const result = await bridge.broadcastImage(pendingImageB64);
            if (result.error) throw new Error(result.error);
            streamImage.src = `data:image/jpeg;base64,${pendingImageB64}`;
            showPreview("image");
            indImage.classList.add("active");
            statusBar.textContent = `Image sent to ${result.sent} bot(s)`;
          } catch (err) {
            toggleImage.classList.remove("on");
            indImage.classList.remove("active");
            statusBar.textContent = `Image failed: ${err.message}`;
          } finally {
            toggleImage.classList.remove("busy");
            outputToggleBusy = false;
          }
        })();
      } else if (toggleImage.classList.contains("on")) {
        broadcastCurrentImage();
      }
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

async function broadcastCurrentImage() {
  if (!pendingImageB64) return;
  try {
    const result = await bridge.broadcastImage(pendingImageB64);
    streamImage.src = `data:image/jpeg;base64,${pendingImageB64}`;
    showPreview("image");
    toggleImage.classList.add("on");
    indImage.classList.add("active");
    statusBar.textContent = result.error
      ? `Broadcast failed: ${result.error}`
      : `Image sent to ${result.sent} bot(s)`;
  } catch (err) {
    statusBar.textContent = `Broadcast failed: ${err.message}`;
  }
}

modalSend.addEventListener("click", async () => {
  if (!pendingImageB64 || outputToggleBusy) return;
  modalSend.disabled = true;
  modalSend.textContent = "Sending...";

  outputToggleBusy = true;
  deactivateAllOutputs();
  toggleImage.classList.add("on");
  toggleImage.classList.add("busy");

  try {
    // DELETE output_media first (camera webpage takes precedence over output_video JPEG)
    await bridge.deactivateOutputMedia().catch(() => {});
    const result = await bridge.broadcastImage(pendingImageB64);
    if (result.error) throw new Error(result.error);
    streamImage.src = `data:image/jpeg;base64,${pendingImageB64}`;
    showPreview("image");
    indImage.classList.add("active");
    statusBar.textContent = `Image sent to ${result.sent} bot(s)`;
  } catch (err) {
    toggleImage.classList.remove("on");
    indImage.classList.remove("active");
    statusBar.textContent = `Broadcast failed: ${err.message}`;
  } finally {
    toggleImage.classList.remove("busy");
    outputToggleBusy = false;
  }

  modalSend.textContent = "Send";
  closeModal();
});

function updateTilePreview(botId, b64) {
  // Bot tiles no longer have previews — no-op
}

// ── Render bot tiles ──────────────────────────────────────────────────
const ROOM_COLORS = ["#00ff88", "#ff9f43", "#ff6b6b", "#a55eea", "#2ed573", "#ffa502", "#ff4757"];

function renderBots() {
  if (activeBots.length === 0) {
    // Clear room sections but preserve the panel title
    botGrid.querySelectorAll(".room-section").forEach((s) => s.remove());
    botGrid.querySelectorAll(":scope > .bot-tile").forEach((t) => t.remove());
    if (!botGrid.contains(emptyState)) botGrid.appendChild(emptyState);
    emptyState.style.display = "flex";
    return;
  }

  emptyState.style.display = "none";

  // Always use grouped view — bots without a breakout room go into "Meeting"
  renderBotsGrouped();
}

function renderBotsGrouped() {
  // Remove any flat tiles sitting directly in bot-grid
  botGrid.querySelectorAll(":scope > .bot-tile").forEach((t) => t.remove());
  botGrid.querySelectorAll(".empty-state").forEach((el) => el.remove());

  // Group bots by breakout room
  const groups = new Map();
  for (const bot of activeBots) {
    const room = bot.breakoutRoom || "Main Room";
    if (!groups.has(room)) groups.set(room, []);
    groups.get(room).push(bot);
  }

  // Sort: Main Room first, then alphabetical
  const sortedRooms = [...groups.keys()].sort((a, b) => {
    if (a === "Main Room") return -1;
    if (b === "Main Room") return 1;
    return a.localeCompare(b);
  });

  const existingSections = new Map();
  botGrid.querySelectorAll(".room-section").forEach((sec) => {
    existingSections.set(sec.dataset.room, sec);
  });

  let colorIdx = 0;
  for (const room of sortedRooms) {
    const bots = groups.get(room);
    const color = room === "Main Room" ? "#4f8eff" : ROOM_COLORS[colorIdx++ % ROOM_COLORS.length];

    // Collect unique participants across all bots in this room
    // Collect participants from activeParticipants (realtime) and meetingParticipants (REST fallback)
    const participantMap = new Map();
    for (const bot of bots) {
      for (const p of (bot.activeParticipants || [])) {
        const id = typeof p === "object" ? p.id : p;
        const name = typeof p === "object" ? p.name : p;
        if (!participantMap.has(String(id))) participantMap.set(String(id), name);
      }
      for (const p of (bot.meetingParticipants || [])) {
        if (!participantMap.has(String(p.id))) participantMap.set(String(p.id), p.name);
      }
    }
    // Filter out bots from participant count
    const botNames = new Set(activeBots.map((b) => b.name));
    const participants = [...participantMap.values()].filter((name) => !botNames.has(name));

    let section = existingSections.get(room);
    if (!section) {
      section = document.createElement("div");
      section.className = "room-section";
      section.dataset.room = room;
      section.innerHTML = `
        <div class="room-header">
          <span class="room-dot" style="background:${color}"></span>
          <span class="room-name">${room}</span>
          <span class="room-count">${bots.length} bot(s) · ${participants.length} participant(s)</span>
        </div>
        <div class="room-bots"></div>
      `;
      botGrid.appendChild(section);
    } else {
      section.querySelector(".room-count").textContent = `${bots.length} bot(s) · ${participants.length} participant(s)`;
      section.querySelector(".room-dot").style.background = color;
      existingSections.delete(room);
    }



    const container = section.querySelector(".room-bots");
    const existingTiles = new Map();
    container.querySelectorAll(".bot-tile").forEach((t) => existingTiles.set(t.dataset.botId, t));

    for (const bot of bots) {
      let tile = existingTiles.get(bot.id);
      if (!tile) {
        tile = createBotTile(bot);
        container.appendChild(tile);
      } else {
        updateBotTile(tile, bot);
        existingTiles.delete(bot.id);
      }
    }
    for (const [, tile] of existingTiles) tile.remove();
  }

  // Remove sections for rooms that no longer exist
  for (const [, sec] of existingSections) sec.remove();
}

// HLS players (kept for potential future use)
const hlsPlayers = new Map();

function createBotTile(bot) {
  const tile = document.createElement("div");
  tile.className = "bot-tile";
  tile.dataset.botId = bot.id;

  const isActive = !["done", "fatal", "leaving"].includes(bot.status);

  // Build stored transcript HTML from server-persisted lines
  let storedTranscriptHtml = "";
  if (bot.transcriptLines && bot.transcriptLines.length > 0) {
    storedTranscriptHtml = bot.transcriptLines.map((line) => {
      if (line.speaker) {
        const color = speakerColor(line.speaker);
        const initials = escapeHtml(speakerInitials(line.speaker));
        return `<div class="transcript-line"><span class="speaker-avatar" style="background:${color}">${initials}</span><span class="transcript-line-text"><span class="speaker">${escapeHtml(line.speaker)}:</span> ${escapeHtml(line.text)}</span></div>`;
      }
      return `<div class="transcript-line">${escapeHtml(line.text)}</div>`;
    }).join("");
  }

  const transcriptContent = storedTranscriptHtml
    ? storedTranscriptHtml
    : (isActive ? '<div style="color:#555;font-style:italic">Listening for transcript...</div>' : '');

  tile.innerHTML = `
    <span class="bot-tile-name">${bot.name}</span>
    <span class="bot-tile-status-text">${formatStatus(bot.status)}</span>
    <div class="bot-tile-indicator ${isActive ? "active" : ""}"></div>
    <div class="feature-toggle ${isActive ? "on" : ""}" data-bot-id="${bot.id}"></div>
    <div class="bot-tile-transcript" id="transcript-${bot.id}" ${storedTranscriptHtml ? 'data-has-data="1"' : ''}>${transcriptContent}</div>
  `;

  tile.querySelector(".feature-toggle").addEventListener("click", async () => {
    const toggle = tile.querySelector(".feature-toggle");
    if (toggle.classList.contains("on")) {
      try {
        toggle.classList.remove("on");
        tile.querySelector(".bot-tile-indicator").classList.remove("active");
        await bridge.removeBot(bot.id);
        statusBar.textContent = `Disconnected ${bot.name}`;
      } catch (err) {
        statusBar.textContent = `Failed to disconnect ${bot.name}: ${err.message}`;
      }
    }
  });

  return tile;
}

function tryStartHlsPlayer(botId) {
  if (hlsPlayers.has(botId)) return; // already running
  if (typeof Hls === "undefined" || !Hls.isSupported()) return;

  const videoEl = document.getElementById(`hls-${botId}`);
  if (!videoEl) return;

  const hlsUrl = `http://localhost:8000/live/${botId}/index.m3u8`;
  const hls = new Hls({
    liveSyncDurationCount: 1,
    liveMaxLatencyDurationCount: 3,
    enableWorker: true,
  });

  hls.loadSource(hlsUrl);
  hls.attachMedia(videoEl);

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    videoEl.style.display = "block";
    const placeholder = videoEl.parentElement?.querySelector("span");
    if (placeholder) placeholder.style.display = "none";
    videoEl.play().catch(() => {});
    console.log(`[hls] Playing stream for ${botId}`);
  });

  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) {
      // Stream not ready yet — retry in 3s
      hls.destroy();
      hlsPlayers.delete(botId);
      setTimeout(() => tryStartHlsPlayer(botId), 3000);
    }
  });

  hlsPlayers.set(botId, hls);
}

function destroyHlsPlayer(botId) {
  const hls = hlsPlayers.get(botId);
  if (hls) {
    hls.destroy();
    hlsPlayers.delete(botId);
  }
}

function updateBotTile(tile, bot) {
  const nameEl = tile.querySelector(".bot-tile-name");
  nameEl.textContent = bot.name;

  const statusText = tile.querySelector(".bot-tile-status-text");
  statusText.textContent = formatStatus(bot.status);

  const isActive = !["done", "fatal", "leaving"].includes(bot.status);
  const indicator = tile.querySelector(".bot-tile-indicator");
  const toggle = tile.querySelector(".feature-toggle");

  if (isActive) {
    indicator.classList.add("active");
    toggle.classList.add("on");
  } else {
    indicator.classList.remove("active");
    toggle.classList.remove("on");
  }
}

function formatStatus(status) {
  const labels = {
    joining_call: "Joining...",
    in_waiting_room: "Waiting Room",
    in_call_not_recording: "In Call",
    in_call_recording: "Recording",
    recording_permission_allowed: "Recording",
    recording_permission_denied: "Denied",
    in_breakout_room: "Breakout Room",
    call_ended: "Ended",
    done: "Done",
    fatal: "Error",
    leaving: "Leaving...",
  };
  return labels[status] || status;
}

// ── Polling ───────────────────────────────────────────────────────────
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    try {
      const bots = await bridge.listBots();
      if (Array.isArray(bots)) {
        activeBots = bots;
        renderBots();
    

        const active = bots.filter(
          (b) => !["done", "fatal"].includes(b.status)
        );
        const inBreakout = bots.filter(
          (b) => b.status === "in_breakout_room"
        );
        statusBar.textContent =
          `${bots.length} bot(s) | ${active.length} active | ${inBreakout.length} in breakout rooms`;

        // Poll transcripts only for FINISHED bots (live bots use WebSocket)
        for (const bot of bots) {
          if (["done"].includes(bot.status)) {
            updateTranscript(bot.id);
          }
        }

        if (active.length === 0 && bots.length > 0) {
          stopPolling();
          statusBar.textContent += " (all finished)";
        }
      }
    } catch {
      // Ignore polling errors
    }
  }, 2000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function updateTranscript(botId) {
  try {
    const el = document.getElementById(`transcript-${botId}`);
    if (!el) return;

    // Skip poll if this bot is already receiving real-time WebSocket data or has stored transcripts
    if (el.dataset.realtime === "1" || el.dataset.hasData === "1") return;

    const data = await bridge.getBotTranscript(botId);

    // Handle array of transcript segments or results array
    const segments = Array.isArray(data) ? data : data?.results || [];
    if (segments.length === 0) return;

    const html = segments
      .slice(-5)
      .map((seg) => {
        const text =
          seg.words?.map((w) => w.text).join(" ") || seg.text || "";
        if (!text.trim()) return null;
        const speaker = seg.participant?.name || seg.speaker || "";
        if (speaker) {
          const color = speakerColor(speaker);
          const initials = escapeHtml(speakerInitials(speaker));
          return `<div class="transcript-line"><span class="speaker-avatar" style="background:${color}">${initials}</span><span class="transcript-line-text"><span class="speaker">${escapeHtml(speaker)}:</span> ${escapeHtml(text)}</span></div>`;
        }
        return `<div class="transcript-line">${escapeHtml(text)}</div>`;
      })
      .filter(Boolean)
      .join("");

    if (html && html !== el.innerHTML) {
      el.innerHTML = html;
      el.scrollTop = el.scrollHeight;
    }
  } catch {
    // Transcript not available yet
  }
}

// ── Stop helpers (used by toggles and cleanup) ───────────────────────

function stopCamera() {
  stopVideoRecorder();
  if (videoStream) {
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
  }
  streamVideo.srcObject = null;
  cameraSource.disabled = false;
  bridge.streamStop();
  toggleCamera.classList.remove("on");
  indCamera.classList.remove("active");
  updateStreamInfo();
}

function stopAudioStream() {
  if (audioChunkInterval) {
    clearInterval(audioChunkInterval);
    audioChunkInterval = null;
  }
  if (audioRecorder) {
    audioRecorder.stop();
    audioRecorder = null;
  }
  if (audioSocket) {
    audioSocket.close();
    audioSocket = null;
  }
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  toggleAudio.classList.remove("on");
  indAudio.classList.remove("active");
  updateStreamInfo();
}

// ── Mutual exclusion: only one video output at a time ─────────────────
// output_media (Camera, URL) and output_video (Image) are mutually exclusive.
// Audio is also exclusive with output_media. Turning one ON turns the others OFF.

// Clean up UI + local streams only (no API call — avoids race conditions)
function deactivateAllOutputs() {
  if (toggleCamera.classList.contains("on")) {
    stopCamera();
    showPreview("none");
  }
  if (toggleImage.classList.contains("on")) {
    toggleImage.classList.remove("on");
    indImage.classList.remove("active");
    showPreview("none");
  }
  if (toggleVideo.classList.contains("on")) {
    toggleVideo.classList.remove("on");
    indVideo.classList.remove("active");
    streamVideo.src = "";
    streamVideo.srcObject = null;
    showPreview("none");
  }
  if (toggleMusic.classList.contains("on")) {
    toggleMusic.classList.remove("on");
    indMusic.classList.remove("active");
    showPreview("none");
  }
  if (toggleUrl.classList.contains("on")) {
    toggleUrl.classList.remove("on");
    indUrl.classList.remove("active");
    showPreview("none");
  }
  if (toggleAudio.classList.contains("on")) {
    stopAudioStream();
  }
}

// Full cleanup: UI + DELETE output_media on Recall API
async function deactivateAllOutputsAndApi() {
  deactivateAllOutputs();
  await bridge.deactivateOutputMedia().catch(() => {});
}

// ── Camera toggle ─────────────────────────────────────────────────────

let videoRecorder = null;

// Populate video input device list
async function populateVideoDevices() {
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
    tempStream.getTracks().forEach((t) => t.stop());
  } catch { /* permission denied — labels will be generic */ }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((d) => d.kind === "videoinput");
  // Remove old camera device options (keep placeholder + Screen Capture)
  while (cameraSource.options.length > 2) cameraSource.remove(2);
  // Insert camera devices before Screen Capture
  const screenOpt = cameraSource.options[1]; // "Screen Capture"
  for (const dev of videoInputs) {
    const opt = document.createElement("option");
    opt.value = `cam:${dev.deviceId}`;
    opt.textContent = dev.label || `Camera ${videoInputs.indexOf(dev) + 1}`;
    cameraSource.insertBefore(opt, screenOpt);
  }
  // Restore last selected device by label (saved to app settings file on disk)
  try {
    const settings = await bridge.getAppSettings();
    if (settings.lastCameraLabel) {
      const match = [...cameraSource.options].find((o) => o.textContent === settings.lastCameraLabel);
      if (match) cameraSource.value = match.value;
    }
  } catch {}
  if (!cameraSource.value && videoInputs.length === 1) {
    cameraSource.selectedIndex = 1;
  }
}
populateVideoDevices();
navigator.mediaDevices.addEventListener("devicechange", populateVideoDevices);
cameraSource.addEventListener("change", () => {
  const selectedOpt = cameraSource.options[cameraSource.selectedIndex];
  if (selectedOpt) bridge.saveAppSettings({ lastCameraLabel: selectedOpt.textContent });
});

// Auto-switch source when dropdown changes while camera is ON
cameraSource.addEventListener("change", async () => {
  if (outputToggleBusy) return;
  if (toggleCamera.classList.contains("on")) {
    stopCamera();
    toggleCamera.click();
  }
});

toggleCamera.addEventListener("click", async () => {
  if (outputToggleBusy) return;

  const turningOff = toggleCamera.classList.contains("on");
  const source = cameraSource.value;

  if (!turningOff && !source) {
    statusBar.textContent = "Select a camera source first";
    return;
  }

  // Instant visual feedback
  outputToggleBusy = true;
  if (turningOff) {
    toggleCamera.classList.remove("on");
    indCamera.classList.remove("active");
  } else {
    deactivateAllOutputs();
    toggleCamera.classList.add("on");
  }
  toggleCamera.classList.add("busy");

  try {
    if (turningOff) {
      stopCamera();
      showPreview("none");
      await bridge.deactivateOutputMedia().catch(() => {});
      statusBar.textContent = "Camera feed cleared";
    } else {
      if (source === "screen") {
        const sources = await bridge.getSources();
        if (sources.length === 0) throw new Error("No screen sources available");
        const screenSource = sources.find((s) => s.name === "Entire Screen") || sources[0];
        videoStream = await navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: screenSource.id,
              maxWidth: 1280,
              maxHeight: 720,
            },
          },
          audio: false,
        });
      } else {
        // Camera device — extract deviceId from "cam:xxx" value
        const deviceId = source.startsWith("cam:") ? source.slice(4) : source;
        videoStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
      }

      streamVideo.srcObject = videoStream;
      cameraSource.disabled = true;
      startVideoRecorder();
      indCamera.classList.add("active");
      showPreview("camera");
      bridge.activateOutputMedia();
      statusBar.textContent = "Camera streaming (HLS)";
    }
  } catch (err) {
    if (turningOff) {
      toggleCamera.classList.add("on");
      indCamera.classList.add("active");
    } else {
      toggleCamera.classList.remove("on");
      indCamera.classList.remove("active");
    }
    statusBar.textContent = `Camera failed: ${err.message}`;
  } finally {
    toggleCamera.classList.remove("busy");
    outputToggleBusy = false;
  }
});

async function startVideoRecorder() {
  if (videoRecorder || !videoStream) return;

  // Open WebSocket for video chunks (bypasses IPC + HTTP overhead)
  videoSocket = new WebSocket("ws://localhost:3000/ws/video-stream");
  videoSocket.binaryType = "arraybuffer";
  try {
    await new Promise((resolve, reject) => {
      videoSocket.onopen = resolve;
      videoSocket.onerror = () => reject(new Error("Video WebSocket failed"));
      setTimeout(() => reject(new Error("Video WebSocket timeout")), 5000);
    });
  } catch (err) {
    console.error("[stream] Video WebSocket connection failed:", err);
    videoSocket = null;
    return;
  }

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
    ? "video/webm;codecs=vp8"
    : "video/webm";

  videoRecorder = new MediaRecorder(videoStream, {
    mimeType,
    videoBitsPerSecond: 2500000,
  });

  videoRecorder.ondataavailable = async (e) => {
    if (e.data.size === 0) return;
    const buffer = await e.data.arrayBuffer();
    if (videoSocket && videoSocket.readyState === WebSocket.OPEN) {
      videoSocket.send(buffer);
    }
    framesSent++;
    if (framesSent % 10 === 0) updateStreamInfo();
  };

  // 500ms timeslice
  videoRecorder.start(500);
  framesSent = 0;
  console.log("[stream] MediaRecorder started (WebSocket):", mimeType);
  updateStreamInfo();
}

function stopVideoRecorder() {
  if (videoRecorder) {
    videoRecorder.stop();
    videoRecorder = null;
  }
  if (videoSocket) {
    videoSocket.close();
    videoSocket = null;
  }
  updateStreamInfo();
}

function updateStreamInfo() {
  const videoActive = videoStream !== null;
  const audioActive = audioRecorder !== null;
  const activeBotCount = activeBots.filter(
    (b) => !["done", "fatal", "leaving"].includes(b.status)
  ).length;

  let fpsDisplay;
  if (outputMediaMode) {
    fpsDisplay = videoActive ? "~15" : "0";
  } else {
    fpsDisplay = activeBotCount > 0 ? (5 / activeBotCount).toFixed(1) : "0";
  }

  const modeLabel = outputMediaMode ? "Webpage" : "API";
  const modeColor = outputMediaMode ? "#00c853" : "#ffab00";

  streamInfo.innerHTML =
    `Video: ${videoActive ? "streaming" : "stopped"} | ` +
    `Audio: ${audioActive ? "recording" : "stopped"} | ` +
    `Sent: ${framesSent} frames | ` +
    `Rate: <span class="rate">~${fpsDisplay} fps/bot</span> | ` +
    `Mode: <span style="color:${modeColor}">${modeLabel}</span>`;
}

// ── Image toggle ──────────────────────────────────────────────────────

btnPickImage.addEventListener("click", () => {
  modalTargetBotId = null;
  modalTitle.textContent = "Choose Image";
  openModal();
});

toggleImage.addEventListener("click", async () => {
  if (outputToggleBusy) return;

  const turningOff = toggleImage.classList.contains("on");

  if (!turningOff && !pendingImageB64) {
    modalTargetBotId = null;
    modalTitle.textContent = "Choose Image";
    openModal();
    return;
  }

  outputToggleBusy = true;
  if (turningOff) {
    toggleImage.classList.remove("on");
    indImage.classList.remove("active");
  } else {
    deactivateAllOutputs();
    toggleImage.classList.add("on");
  }
  toggleImage.classList.add("busy");

  try {
    if (turningOff) {
      showPreview("none");
      await bridge.deactivateOutputMedia().catch(() => {});
      statusBar.textContent = "Image feed cleared";
    } else {
      // DELETE output_media first (camera webpage takes precedence over output_video JPEG)
      await bridge.deactivateOutputMedia().catch(() => {});
      const result = await bridge.broadcastImage(pendingImageB64);
      if (result.error) throw new Error(result.error);
      streamImage.src = `data:image/jpeg;base64,${pendingImageB64}`;
      showPreview("image");
      indImage.classList.add("active");
      statusBar.textContent = `Image sent to ${result.sent} bot(s)`;
    }
  } catch (err) {
    if (turningOff) {
      toggleImage.classList.add("on");
      indImage.classList.add("active");
    } else {
      toggleImage.classList.remove("on");
      indImage.classList.remove("active");
    }
    statusBar.textContent = `Image failed: ${err.message}`;
  } finally {
    toggleImage.classList.remove("busy");
    outputToggleBusy = false;
  }
});

// ── URL toggle + send ─────────────────────────────────────────────────

async function pushUrlToBots() {
  if (outputToggleBusy) return false;

  let url = urlInput.value.trim();
  if (!url) {
    statusBar.textContent = "Enter a URL first";
    urlInput.focus();
    return false;
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
    urlInput.value = url;
  }

  // Detect YouTube URLs — will use tunnel proxy page to avoid Error 153
  const ytMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([\w-]+)/
  );

  outputToggleBusy = true;
  deactivateAllOutputs();
  toggleUrl.classList.add("on");
  toggleUrl.classList.add("busy");

  try {
    let sent = 0;
    if (ytMatch) {
      // YouTube: activate via server (serves proxied page through tunnel)
      const result = await bridge.activateYouTube(ytMatch[1]);
      if (result.error) throw new Error(result.error);
      sent = result.activated || 0;
    } else {
      // Regular URL: send directly to each bot
      for (const bot of activeBots) {
        if (["done", "fatal", "leaving"].includes(bot.status)) continue;
        const result = await bridge.startOutputMedia(bot.id, url);
        if (result.error) throw new Error(result.error);
        sent++;
      }
    }

    indUrl.classList.add("active");
    statusBar.textContent = `URL output active on ${sent} bot(s): ${url}`;
    return true;
  } catch (err) {
    toggleUrl.classList.remove("on");
    indUrl.classList.remove("active");
    statusBar.textContent = `URL failed: ${err.message}`;
    return false;
  } finally {
    toggleUrl.classList.remove("busy");
    outputToggleBusy = false;
  }
}

toggleUrl.addEventListener("click", async () => {
  if (outputToggleBusy) return;

  if (toggleUrl.classList.contains("on")) {
    outputToggleBusy = true;
    toggleUrl.classList.remove("on");
    indUrl.classList.remove("active");
    toggleUrl.classList.add("busy");

    try {
      showPreview("none");
      await bridge.deactivateOutputMedia().catch(() => {});
      statusBar.textContent = "URL feed cleared";
    } catch (err) {
      toggleUrl.classList.add("on");
      indUrl.classList.add("active");
    } finally {
      toggleUrl.classList.remove("busy");
      outputToggleBusy = false;
    }
    return;
  }
  await pushUrlToBots();
});

// Row click handlers — clicking the row acts as the on/off toggle
rowCamera.addEventListener("click", (e) => {
  // Don't trigger if clicking the select dropdown
  if (e.target.closest("select")) return;
  toggleCamera.click();
});

rowUrl.addEventListener("click", (e) => {
  // Don't trigger if clicking inside the URL input
  if (e.target.closest("input")) return;
  // If URL is on, turn it off; otherwise send/activate
  if (toggleUrl.classList.contains("on")) {
    toggleUrl.click();
  } else {
    pushUrlToBots();
  }
});

rowAudio.addEventListener("click", (e) => {
  if (e.target.closest("select")) return;
  toggleAudio.click();
});

// Image row: click to pick file or toggle on/off
rowImage.addEventListener("click", () => {
  if (outputToggleBusy) return;
  if (toggleImage.classList.contains("on")) {
    toggleImage.click(); // turn off
  } else {
    // Open file picker (uses the image modal)
    fileInput.click();
  }
});

// Video row: click to pick file or toggle on/off
rowVideo.addEventListener("click", () => {
  if (outputToggleBusy) return;
  if (toggleVideo.classList.contains("on")) {
    toggleVideo.click(); // turn off
  } else {
    videoFileInput.click();
  }
});

// Music row: click to pick file or toggle on/off
rowMusic.addEventListener("click", () => {
  if (outputToggleBusy) return;
  if (toggleMusic.classList.contains("on")) {
    toggleMusic.click(); // turn off
  } else {
    musicFileInput.click();
  }
});

// Enter key in URL input pushes URL
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pushUrlToBots();
});

// ── Video file upload + toggle ────────────────────────────────────────

btnPickVideo.addEventListener("click", () => videoFileInput.click());

videoFileInput.addEventListener("change", async () => {
  const file = videoFileInput.files?.[0];
  if (!file) return;
  videoFileInput.value = "";

  const displayName = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
  videoFileName.textContent = displayName;
  videoFileName.style.color = "#ccc";

  // Local preview blob URL
  if (videoFileUrl) URL.revokeObjectURL(videoFileUrl);
  videoFileUrl = URL.createObjectURL(file);

  // Upload to server and auto-activate
  statusBar.textContent = "Uploading video...";
  outputToggleBusy = true;
  deactivateAllOutputs();
  toggleVideo.classList.add("on", "busy");

  try {
    const buffer = await file.arrayBuffer();
    const result = await bridge.uploadVideo(file.name, buffer);
    if (result.error) {
      toggleVideo.classList.remove("on");
      statusBar.textContent = `Video upload failed: ${result.error}`;
      return;
    }
    videoUploaded = true;
    btnPickVideo.textContent = displayName;
    statusBar.textContent = `Video uploaded: ${file.name}`;

    await activateVideoOutput();
  } catch (err) {
    toggleVideo.classList.remove("on");
    indVideo.classList.remove("active");
    statusBar.textContent = `Video upload failed: ${err.message}`;
  } finally {
    toggleVideo.classList.remove("busy");
    outputToggleBusy = false;
  }
});

async function activateVideoOutput() {
  try {
    const result = await bridge.activateVideoOutput();
    if (result.error) {
      statusBar.textContent = `Video activation failed: ${result.error}`;
      return;
    }
    streamVideo.srcObject = null;
    streamVideo.src = videoFileUrl;
    streamVideo.loop = true;
    streamVideo.play().catch(() => {});
    showPreview("video");
    toggleVideo.classList.add("on");
    indVideo.classList.add("active");
    statusBar.textContent = `Video output active on ${result.activated} bot(s)`;
  } catch (err) {
    statusBar.textContent = `Video activation failed: ${err.message}`;
  }
}

toggleVideo.addEventListener("click", async () => {
  if (outputToggleBusy) return;

  const turningOff = toggleVideo.classList.contains("on");

  if (!turningOff && !videoUploaded) {
    videoFileInput.click();
    return;
  }

  outputToggleBusy = true;
  if (turningOff) {
    toggleVideo.classList.remove("on");
    indVideo.classList.remove("active");
  } else {
    deactivateAllOutputs();
    toggleVideo.classList.add("on");
  }
  toggleVideo.classList.add("busy");

  try {
    if (turningOff) {
      streamVideo.src = "";
      streamVideo.srcObject = null;
      showPreview("none");
      await bridge.deactivateOutputMedia().catch(() => {});
      statusBar.textContent = "Video feed cleared";
    } else {
      const result = await bridge.activateVideoOutput();
      if (result.error) throw new Error(result.error);
      streamVideo.srcObject = null;
      streamVideo.src = videoFileUrl;
      streamVideo.loop = true;
      streamVideo.play().catch(() => {});
      showPreview("video");
      indVideo.classList.add("active");
      statusBar.textContent = `Video output active on ${result.activated} bot(s)`;
    }
  } catch (err) {
    if (turningOff) {
      toggleVideo.classList.add("on");
      indVideo.classList.add("active");
    } else {
      toggleVideo.classList.remove("on");
      indVideo.classList.remove("active");
    }
    statusBar.textContent = `Video failed: ${err.message}`;
  } finally {
    toggleVideo.classList.remove("busy");
    outputToggleBusy = false;
  }
});


// ── Music file upload + toggle ────────────────────────────────────────

btnPickMusic.addEventListener("click", () => musicFileInput.click());

musicFileInput.addEventListener("change", async () => {
  const file = musicFileInput.files?.[0];
  if (!file) return;
  musicFileInput.value = "";

  const displayName = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
  musicFileName.textContent = displayName;
  musicFileName.style.color = "#ccc";

  statusBar.textContent = "Uploading music...";
  outputToggleBusy = true;
  deactivateAllOutputs();
  toggleMusic.classList.add("on", "busy");

  try {
    const buffer = await file.arrayBuffer();
    const result = await bridge.uploadMusic(file.name, buffer);
    if (result.error) {
      toggleMusic.classList.remove("on");
      statusBar.textContent = `Music upload failed: ${result.error}`;
      return;
    }
    musicUploaded = true;
    btnPickMusic.textContent = displayName;
    statusBar.textContent = `Music uploaded: ${file.name}`;

    await activateMusicOutput();
  } catch (err) {
    toggleMusic.classList.remove("on");
    indMusic.classList.remove("active");
    statusBar.textContent = `Music upload failed: ${err.message}`;
  } finally {
    toggleMusic.classList.remove("busy");
    outputToggleBusy = false;
  }
});

async function activateMusicOutput() {
  try {
    const result = await bridge.activateMusicOutput();
    if (result.error) {
      statusBar.textContent = `Music activation failed: ${result.error}`;
      return;
    }
    showPreview("none");
    toggleMusic.classList.add("on");
    indMusic.classList.add("active");
    statusBar.textContent = `Music output active on ${result.activated} bot(s)`;
  } catch (err) {
    statusBar.textContent = `Music activation failed: ${err.message}`;
  }
}

toggleMusic.addEventListener("click", async () => {
  if (outputToggleBusy) return;

  const turningOff = toggleMusic.classList.contains("on");

  if (!turningOff && !musicUploaded) {
    musicFileInput.click();
    return;
  }

  outputToggleBusy = true;
  if (turningOff) {
    toggleMusic.classList.remove("on");
    indMusic.classList.remove("active");
  } else {
    deactivateAllOutputs();
    toggleMusic.classList.add("on");
  }
  toggleMusic.classList.add("busy");

  try {
    if (turningOff) {
      showPreview("none");
      await bridge.deactivateOutputMedia().catch(() => {});
      statusBar.textContent = "Music feed cleared";
    } else {
      const result = await bridge.activateMusicOutput();
      if (result.error) throw new Error(result.error);
      showPreview("none");
      indMusic.classList.add("active");
      statusBar.textContent = `Music output active on ${result.activated} bot(s)`;
    }
  } catch (err) {
    if (turningOff) {
      toggleMusic.classList.add("on");
      indMusic.classList.add("active");
    } else {
      toggleMusic.classList.remove("on");
      indMusic.classList.remove("active");
    }
    statusBar.textContent = `Music failed: ${err.message}`;
  } finally {
    toggleMusic.classList.remove("busy");
    outputToggleBusy = false;
  }
});

// ── Audio toggle ──────────────────────────────────────────────────────

const audioSource = document.getElementById("audio-source");

// Populate audio input device list
async function populateAudioDevices() {
  // Request permission first so labels are available
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach((t) => t.stop());
  } catch { /* permission denied — labels will be generic */ }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter((d) => d.kind === "audioinput");
  // Keep the placeholder, remove old options
  while (audioSource.options.length > 1) audioSource.remove(1);
  for (const dev of audioInputs) {
    const opt = document.createElement("option");
    opt.value = dev.deviceId;
    opt.textContent = dev.label || `Microphone ${audioSource.options.length}`;
    audioSource.appendChild(opt);
  }
  // Restore last selected device by label (saved to app settings file on disk)
  try {
    const settings = await bridge.getAppSettings();
    if (settings.lastAudioLabel) {
      const match = [...audioSource.options].find((o) => o.textContent === settings.lastAudioLabel);
      if (match) audioSource.value = match.value;
    }
  } catch {}
  if (!audioSource.value && audioInputs.length === 1) {
    audioSource.selectedIndex = 1;
  }
}
populateAudioDevices();
navigator.mediaDevices.addEventListener("devicechange", populateAudioDevices);
audioSource.addEventListener("change", () => {
  const selectedOpt = audioSource.options[audioSource.selectedIndex];
  if (selectedOpt) bridge.saveAppSettings({ lastAudioLabel: selectedOpt.textContent });
});

toggleAudio.addEventListener("click", async () => {
  if (outputToggleBusy) return;

  const turningOff = toggleAudio.classList.contains("on");
  const deviceId = audioSource.value;

  if (!turningOff && !deviceId) {
    statusBar.textContent = "Select an audio device first";
    return;
  }

  outputToggleBusy = true;
  if (turningOff) {
    toggleAudio.classList.remove("on");
    indAudio.classList.remove("active");
  } else {
    deactivateAllOutputs();
    toggleAudio.classList.add("on");
  }
  toggleAudio.classList.add("busy");

  try {
    if (turningOff) {
      stopAudioStream();
      await bridge.deactivateOutputMedia().catch(() => {});
      statusBar.textContent = "Audio feed cleared";
    } else {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      });

      // Connect WebSocket for gapless audio streaming
      audioSocket = new WebSocket("ws://localhost:3000/ws/audio-push");
      audioSocket.binaryType = "arraybuffer";
      await new Promise((resolve, reject) => {
        audioSocket.onopen = resolve;
        audioSocket.onerror = () => reject(new Error("Audio WebSocket failed"));
        setTimeout(() => reject(new Error("Audio WebSocket timeout")), 5000);
      });

      audioRecorder = new MediaRecorder(audioStream, {
        mimeType: "audio/webm;codecs=opus",
      });

      // Continuous stream — send webm chunks to server via WebSocket
      audioRecorder.ondataavailable = async (e) => {
        if (e.data.size === 0) return;
        const buffer = await e.data.arrayBuffer();
        if (audioSocket && audioSocket.readyState === WebSocket.OPEN) {
          audioSocket.send(buffer);
        }
      };

      // Continuous recording — requestData() flushes without stopping
      audioRecorder.start();
      audioChunkInterval = setInterval(() => {
        if (audioRecorder && audioRecorder.state === "recording") {
          audioRecorder.requestData();
        }
      }, 1000);

      indAudio.classList.add("active");
      statusBar.textContent = "Audio streaming";
      updateStreamInfo();
    }
  } catch (err) {
    if (turningOff) {
      toggleAudio.classList.add("on");
      indAudio.classList.add("active");
    } else {
      toggleAudio.classList.remove("on");
      indAudio.classList.remove("active");
    }
    statusBar.textContent = `Audio failed: ${err.message}`;
  } finally {
    toggleAudio.classList.remove("busy");
    outputToggleBusy = false;
  }
});

// ── Startup: recover any existing bots from server ───────────────────
(async () => {
  // Retry a few times — server may still be recovering bots on startup
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const bots = await bridge.listBots();
      if (Array.isArray(bots) && bots.length > 0) {
        // Load ALL bots (including done) so transcripts and room state persist
        activeBots = bots;
        renderBots();

        const active = bots.filter(
          (b) => !["done", "fatal", "media_expired"].includes(b.status)
        );
        if (active.length > 0) {
          startPolling();
        }
        btnRemoveAll.disabled = false;
        statusBar.textContent = `Recovered ${bots.length} bot(s) (${active.length} active)`;
        return;
      }
    } catch {
      // Server not ready yet — retry
    }
  }
})();

// ── Settings Modal ─────────────────────────────────────────────────────

function updateDeepgramHint() {
  deepgramHint.style.display = settingsProvider.value === "deepgram" ? "block" : "none";
}

settingsProvider.addEventListener("change", updateDeepgramHint);

const webhookUrlDisplay = document.getElementById("webhook-url-display");
const btnCopyWebhook = document.getElementById("btn-copy-webhook");
const btnOpenDashboard = document.getElementById("btn-open-dashboard");

btnSettings.addEventListener("click", async () => {
  const settings = await window.recallBridge.getAppSettings();
  settingsProvider.value = settings.transcriptionProvider || "recallai";
  updateDeepgramHint();
  // Load webhook URL
  try {
    const info = await bridge.getTunnelInfo();
    webhookUrlDisplay.value = info.smeeUrl || info.webhookUrl || "Starting...";
  } catch { webhookUrlDisplay.value = "Unavailable"; }
  settingsModal.classList.add("active");
});

btnCopyWebhook.addEventListener("click", () => {
  navigator.clipboard.writeText(webhookUrlDisplay.value);
  btnCopyWebhook.textContent = "Copied!";
  setTimeout(() => { btnCopyWebhook.textContent = "Copy URL"; }, 2000);
});

btnOpenDashboard.addEventListener("click", () => {
  window.recallBridge.openExternal("https://api.recall.ai/dashboard/webhooks/");
});

settingsCancel.addEventListener("click", () => {
  settingsModal.classList.remove("active");
});

settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.remove("active");
});

settingsSave.addEventListener("click", async () => {
  await window.recallBridge.saveAppSettings({
    transcriptionProvider: settingsProvider.value,
  });
  settingsModal.classList.remove("active");
});
