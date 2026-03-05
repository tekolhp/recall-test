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
const btnSendUrl = document.getElementById("btn-send-url");
const toggleUrl = document.getElementById("toggle-url");
const indUrl = document.getElementById("ind-url");
const toggleAudio = document.getElementById("toggle-audio");
const indAudio = document.getElementById("ind-audio");

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
  btnDeploy.textContent = "Deploying...";
  statusBar.textContent = `Deploying ${botCount} bot(s)...`;

  try {
    const result = await bridge.deployBots(meetingUrl, botCount, namePrefix);

    if (result.error) {
      statusBar.textContent = `Error: ${result.error}`;
      return;
    }

    activeBots = result.created || [];
    outputMediaMode = result.mode === "webpage";
    const modeLabel = outputMediaMode ? "Webpage 30fps" : "API 5fps";
    if (result.errors?.length && activeBots.length === 0) {
      statusBar.textContent = `Deploy failed: ${result.errors[0].error}`;
    } else {
      statusBar.textContent =
        `Deployed ${activeBots.length} bot(s) [${modeLabel}]` +
        (result.errors?.length ? ` (${result.errors.length} failed: ${result.errors[0].error})` : "");
    }

    renderBots();

    startPolling();
    btnRemoveAll.disabled = false;
  } catch (err) {
    statusBar.textContent = `Deploy failed: ${err.message}`;
  } finally {
    btnDeploy.disabled = false;
    btnDeploy.textContent = "Deploy Bots";
  }
});

// ── Remove All ────────────────────────────────────────────────────────
btnRemoveAll.addEventListener("click", async () => {
  btnRemoveAll.disabled = true;
  statusBar.textContent = "Removing all bots...";

  try {
    await deactivateAllOutputsAndApi();
    await bridge.removeAllBots();
    stopPolling();
    activeBots = [];
    renderBots();

    statusBar.textContent = "All bots removed";
    btnRemoveAll.disabled = true;
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
  if (file) loadImageFile(file);
  fileInput.value = "";
});

function loadImageFile(file) {
  if (!file.type.startsWith("image/")) return;

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    // Show preview
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

      // Auto-push if image toggle is already ON
      if (toggleImage.classList.contains("on")) {
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
    botGrid.innerHTML = "";
    botGrid.appendChild(emptyState);
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

  tile.innerHTML = `
    <span class="bot-tile-name">${bot.name}</span>
    <span class="bot-tile-status-text">${formatStatus(bot.status)}</span>
    <div class="bot-tile-indicator ${isActive ? "active" : ""}"></div>
    <div class="feature-toggle ${isActive ? "on" : ""}" data-bot-id="${bot.id}"></div>
    <div class="bot-tile-transcript" id="transcript-${bot.id}">${isActive ? '<div style="color:#555;font-style:italic">Listening for transcript...</div>' : ''}</div>
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

    // Skip poll if this bot is already receiving real-time WebSocket data
    if (el.dataset.realtime === "1") return;

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
      if (source === "camera") {
        videoStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: false,
        });
      } else if (source === "screen") {
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

function startVideoRecorder() {
  if (videoRecorder || !videoStream) return;

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
    ? "video/webm;codecs=vp8"
    : "video/webm";

  videoRecorder = new MediaRecorder(videoStream, {
    mimeType,
    videoBitsPerSecond: 2000000,
  });

  videoRecorder.ondataavailable = async (e) => {
    if (e.data.size === 0) return;
    const buffer = await e.data.arrayBuffer();
    bridge.streamWebmChunk(buffer);
    framesSent++;
    if (framesSent % 10 === 0) updateStreamInfo();
  };

  videoRecorder.start(200);
  framesSent = 0;
  console.log("[stream] MediaRecorder started:", mimeType);
  updateStreamInfo();
}

function stopVideoRecorder() {
  if (videoRecorder) {
    videoRecorder.stop();
    videoRecorder = null;
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
    fpsDisplay = videoActive ? "~30" : "0";
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

// Send button pushes URL (turns on toggle if off)
btnSendUrl.addEventListener("click", () => pushUrlToBots());

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

  // Local preview blob URL
  if (videoFileUrl) URL.revokeObjectURL(videoFileUrl);
  videoFileUrl = URL.createObjectURL(file);

  // Upload to server (read as ArrayBuffer)
  statusBar.textContent = "Uploading video...";
  try {
    const buffer = await file.arrayBuffer();
    const result = await bridge.uploadVideo(file.name, buffer);
    if (result.error) {
      statusBar.textContent = `Video upload failed: ${result.error}`;
      return;
    }
    videoUploaded = true;
    btnPickVideo.textContent = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
    statusBar.textContent = `Video uploaded: ${file.name}`;

    // Auto-re-activate if toggle is already ON
    if (toggleVideo.classList.contains("on") && !outputToggleBusy) {
      outputToggleBusy = true;
      toggleVideo.classList.add("busy");
      try {
        await activateVideoOutput();
      } finally {
        toggleVideo.classList.remove("busy");
        outputToggleBusy = false;
      }
    }
  } catch (err) {
    statusBar.textContent = `Video upload failed: ${err.message}`;
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

  statusBar.textContent = "Uploading music...";
  try {
    const buffer = await file.arrayBuffer();
    const result = await bridge.uploadMusic(file.name, buffer);
    if (result.error) {
      statusBar.textContent = `Music upload failed: ${result.error}`;
      return;
    }
    musicUploaded = true;
    btnPickMusic.textContent = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
    statusBar.textContent = `Music uploaded: ${file.name}`;

    if (toggleMusic.classList.contains("on") && !outputToggleBusy) {
      outputToggleBusy = true;
      toggleMusic.classList.add("busy");
      try {
        await activateMusicOutput();
      } finally {
        toggleMusic.classList.remove("busy");
        outputToggleBusy = false;
      }
    }
  } catch (err) {
    statusBar.textContent = `Music upload failed: ${err.message}`;
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

toggleAudio.addEventListener("click", async () => {
  if (outputToggleBusy) return;

  const turningOff = toggleAudio.classList.contains("on");

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
        audio: true,
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

      // Send raw webm chunks via WebSocket (no base64, no IPC round-trip)
      audioRecorder.ondataavailable = async (e) => {
        if (e.data.size === 0) return;
        const buffer = await e.data.arrayBuffer();
        if (audioSocket && audioSocket.readyState === WebSocket.OPEN) {
          audioSocket.send(buffer);
        }
      };

      // Start continuous recording — requestData() flushes without stopping
      audioRecorder.start();
      audioChunkInterval = setInterval(() => {
        if (audioRecorder && audioRecorder.state === "recording") {
          audioRecorder.requestData(); // gapless: no stop/start cycle
        }
      }, 3000);

      indAudio.classList.add("active");
      statusBar.textContent = "Audio streaming (gapless)";
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
        const active = bots.filter(
          (b) => !["done", "fatal", "media_expired"].includes(b.status)
        );
        if (active.length > 0) {
          activeBots = active;
          renderBots();
      
          startPolling();
          btnRemoveAll.disabled = false;
          statusBar.textContent = `Recovered ${active.length} active bot(s)`;
          return;
        }
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

btnSettings.addEventListener("click", async () => {
  const settings = await window.recallBridge.getAppSettings();
  settingsProvider.value = settings.transcriptionProvider || "recallai";
  updateDeepgramHint();
  settingsModal.classList.add("active");
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
