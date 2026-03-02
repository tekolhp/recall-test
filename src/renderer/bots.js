// ── DOM references ────────────────────────────────────────────────────
const meetingUrlInput = document.getElementById("meeting-url");
const namePrefixInput = document.getElementById("name-prefix");
const botCountSelect = document.getElementById("bot-count");
const btnDeploy = document.getElementById("btn-deploy");
const btnBroadcast = document.getElementById("btn-broadcast");
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
const videoSourceSelect = document.getElementById("video-source");
const btnStartVideo = document.getElementById("btn-start-video");
const btnStopVideo = document.getElementById("btn-stop-video");
const btnStartAudio = document.getElementById("btn-start-audio");
const btnStopAudio = document.getElementById("btn-stop-audio");
const streamInfo = document.getElementById("stream-info");
const btnForceRemove = document.getElementById("btn-force-remove");

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

const bridge = window.recallBridge;

// ── Check ngrok / output media status ────────────────────────────────
async function checkNgrokStatus() {
  try {
    const status = await bridge.getNgrokStatus();
    outputMediaMode = status.available;
    if (outputMediaMode && !pushSocket) {
      connectPushSocket();
    }
    updateStreamInfo();
  } catch {
    outputMediaMode = false;
  }
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

checkNgrokStatus();

// ── Listen for toggle state changes ───────────────────────────────────
if (bridge.onToggleState) {
  bridge.onToggleState((toggles) => {
    const disabled = !toggles.botFleet;
    btnDeploy.disabled = disabled;
    if (disabled) {
      statusBar.textContent = "Bot Fleet is OFF — enable it with the toggle above";
      // Stop streams if running
      if (videoStream) btnStopVideo.click();
      if (audioRecorder) btnStopAudio.click();
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

// ── Deploy ────────────────────────────────────────────────────────────
btnDeploy.addEventListener("click", async () => {
  const meetingUrl = meetingUrlInput.value.trim();
  if (!meetingUrl) {
    meetingUrlInput.focus();
    return;
  }

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
    statusBar.textContent =
      `Deployed ${activeBots.length} bot(s) [${modeLabel}]` +
      (result.errors?.length ? ` (${result.errors.length} failed)` : "");

    renderBots();
    startPolling();
    btnBroadcast.disabled = false;
    btnRemoveAll.disabled = false;
    streamPanel.classList.add("active");
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
    await bridge.removeAllBots();
    stopPolling();
    // Stop any active streams
    btnStopVideo.click();
    btnStopAudio.click();
    streamPanel.classList.remove("active");

    activeBots = [];
    renderBots();
    statusBar.textContent = "All bots removed";
    btnBroadcast.disabled = true;
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
    const result = await bridge.forceRemoveAllBots();
    stopPolling();
    btnStopVideo.click();
    btnStopAudio.click();
    streamPanel.classList.remove("active");
    activeBots = [];
    renderBots();
    btnBroadcast.disabled = true;
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
btnBroadcast.addEventListener("click", () => {
  modalTargetBotId = null;
  modalTitle.textContent = "Broadcast Image to All Bots";
  openModal();
});

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
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

modalSend.addEventListener("click", async () => {
  if (!pendingImageB64) return;

  modalSend.disabled = true;
  modalSend.textContent = "Sending...";

  try {
    if (modalTargetBotId) {
      const result = await bridge.sendImageToBot(
        modalTargetBotId,
        pendingImageB64
      );
      if (result.error) {
        statusBar.textContent = `Send failed: ${result.error}`;
      } else {
        statusBar.textContent = `Sent image to ${modalTargetBotId}`;
        updateTilePreview(modalTargetBotId, pendingImageB64);
      }
    } else {
      const result = await bridge.broadcastImage(pendingImageB64);
      if (result.error) {
        statusBar.textContent = `Broadcast failed: ${result.error}`;
      } else {
        statusBar.textContent = `Broadcast image to ${result.sent} bot(s)`;
        for (const bot of activeBots) {
          updateTilePreview(bot.id, pendingImageB64);
        }
      }
    }
  } catch (err) {
    statusBar.textContent = `Send failed: ${err.message}`;
  }

  modalSend.textContent = "Send";
  closeModal();
});

function updateTilePreview(botId, b64) {
  const preview = document.getElementById(`preview-${botId}`);
  if (!preview) return;
  const img = preview.querySelector("img");
  const placeholder = preview.querySelector("span");
  if (img) {
    img.src = `data:image/jpeg;base64,${b64}`;
    img.style.display = "block";
  }
  if (placeholder) placeholder.style.display = "none";
}

// ── Render bot tiles ──────────────────────────────────────────────────
function renderBots() {
  if (activeBots.length === 0) {
    botGrid.innerHTML = "";
    botGrid.appendChild(emptyState);
    emptyState.style.display = "flex";
    return;
  }

  emptyState.style.display = "none";

  const existingTiles = new Map();
  botGrid.querySelectorAll(".bot-tile").forEach((tile) => {
    existingTiles.set(tile.dataset.botId, tile);
  });

  botGrid.querySelectorAll(".empty-state").forEach((el) => el.remove());

  for (const bot of activeBots) {
    let tile = existingTiles.get(bot.id);

    if (!tile) {
      tile = createBotTile(bot);
      botGrid.appendChild(tile);
    } else {
      updateBotTile(tile, bot);
      existingTiles.delete(bot.id);
    }
  }

  for (const [, tile] of existingTiles) {
    tile.remove();
  }
}

function createBotTile(bot) {
  const tile = document.createElement("div");
  tile.className = "bot-tile";
  tile.dataset.botId = bot.id;

  tile.innerHTML = `
    <div class="bot-tile-header">
      <span class="bot-tile-name">${bot.name}</span>
      <span class="bot-tile-status ${bot.status}">${formatStatus(bot.status)}</span>
    </div>
    <div class="bot-tile-preview" id="preview-${bot.id}">
      <img />
      <span>No image sent yet</span>
    </div>
    <div class="bot-tile-transcript" id="transcript-${bot.id}"></div>
    <div class="bot-tile-actions">
      <button class="btn-send" data-bot-id="${bot.id}">Send Image</button>
      <button class="btn-kick" data-bot-id="${bot.id}">Remove</button>
    </div>
  `;

  tile.querySelector(".btn-send").addEventListener("click", () => {
    modalTargetBotId = bot.id;
    modalTitle.textContent = `Send Image to ${bot.name}`;
    openModal();
  });

  tile.querySelector(".btn-kick").addEventListener("click", async () => {
    try {
      await bridge.removeBot(bot.id);
      statusBar.textContent = `Removed ${bot.id}`;
    } catch (err) {
      statusBar.textContent = `Failed to remove ${bot.id}: ${err.message}`;
    }
  });

  return tile;
}

function updateBotTile(tile, bot) {
  const statusEl = tile.querySelector(".bot-tile-status");
  statusEl.className = `bot-tile-status ${bot.status}`;
  statusEl.textContent = formatStatus(bot.status);

  const nameEl = tile.querySelector(".bot-tile-name");
  nameEl.textContent = bot.breakoutRoom
    ? `${bot.name} — ${bot.breakoutRoom}`
    : bot.name;
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

        // Fetch transcripts for done bots
        for (const bot of bots) {
          if (bot.status === "done") {
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
  }, 5000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function updateTranscript(botId) {
  try {
    const data = await bridge.getBotTranscript(botId);
    const el = document.getElementById(`transcript-${botId}`);
    if (!el) return;

    // Handle array of transcript segments or results array
    const segments = Array.isArray(data) ? data : data?.results || [];
    if (segments.length === 0) return;

    const html = segments
      .slice(-10)
      .map((seg) => {
        const speaker = seg.speaker || seg.participant?.name || "?";
        const text =
          seg.words?.map((w) => w.text).join(" ") || seg.text || "";
        return `<span class="speaker">${speaker}:</span> ${text}`;
      })
      .join("<br>");

    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  } catch {
    // Transcript not available yet
  }
}

// ── Real-time Video Streaming ─────────────────────────────────────────

btnStartVideo.addEventListener("click", async () => {
  const source = videoSourceSelect.value;
  if (!source) {
    statusBar.textContent = "Select a video source first";
    return;
  }

  try {
    if (source === "camera") {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } else if (source === "screen") {
      // Electron desktopCapturer — get sources via IPC, then getUserMedia
      const sources = await bridge.getSources();
      if (sources.length === 0) {
        statusBar.textContent = "No screen sources available";
        return;
      }
      // Use the first screen source
      const screenSource = sources.find((s) => s.name === "Entire Screen") || sources[0];
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: screenSource.id,
            maxWidth: 1920,
            maxHeight: 1080,
          },
        },
        audio: false,
      });
    }

    streamVideo.srcObject = videoStream;
    btnStartVideo.style.display = "none";
    btnStopVideo.style.display = "";
    videoSourceSelect.disabled = true;

    // Calculate fps: 300 req/min total, divided across active bots
    startFrameSending();
    statusBar.textContent = "Video streaming started";
  } catch (err) {
    statusBar.textContent = `Failed to start video: ${err.message}`;
  }
});

btnStopVideo.addEventListener("click", () => {
  stopFrameSending();
  if (videoStream) {
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
  }
  streamVideo.srcObject = null;
  btnStartVideo.style.display = "";
  btnStopVideo.style.display = "none";
  videoSourceSelect.disabled = false;
  statusBar.textContent = "Video streaming stopped";
});

function startFrameSending() {
  if (videoFrameInterval) return;

  framesSent = 0;
  framesErrors = 0;
  const ctx = streamCanvas.getContext("2d");

  function getIntervalMs() {
    if (outputMediaMode) {
      // Webpage mode: ~30fps (no rate limit, frames go via WebSocket)
      return 33;
    }
    // API mode: rate-limited at 300 req/min
    const activeBotCount = activeBots.filter(
      (b) => !["done", "fatal", "leaving"].includes(b.status)
    ).length;
    const n = Math.max(activeBotCount, 1);
    return n * 200;
  }

  async function sendFrame() {
    if (isSendingFrame || !videoStream) return;
    isSendingFrame = true;

    try {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(streamVideo, 0, 0, 1280, 720);

      if (outputMediaMode && pushSocket && pushSocket.readyState === WebSocket.OPEN) {
        // Direct WebSocket: send binary JPEG (no base64, no IPC, no HTTP)
        streamCanvas.toBlob((blob) => {
          if (blob && pushSocket && pushSocket.readyState === WebSocket.OPEN) {
            blob.arrayBuffer().then((buf) => {
              pushSocket.send(buf);
              framesSent++;
              updateStreamInfo();
            });
          }
          isSendingFrame = false;

          if (videoFrameInterval !== null) {
            videoFrameInterval = setTimeout(sendFrame, getIntervalMs());
          }
        }, "image/jpeg", 0.85);
        return; // toBlob is async, the callback handles the rest
      } else {
        // Fallback: broadcast via output_video API (rate-limited)
        const jpegDataUrl = streamCanvas.toDataURL("image/jpeg", 0.80);
        const b64 = jpegDataUrl.split(",")[1];
        await bridge.broadcastImage(b64);
        framesSent++;
        updateStreamInfo();
      }
    } catch {
      framesErrors++;
    } finally {
      isSendingFrame = false;
    }

    if (videoFrameInterval !== null) {
      videoFrameInterval = setTimeout(sendFrame, getIntervalMs());
    }
  }

  videoFrameInterval = setTimeout(sendFrame, 100);
}

function stopFrameSending() {
  if (videoFrameInterval) {
    clearTimeout(videoFrameInterval);
    videoFrameInterval = null;
  }
  isSendingFrame = false;
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

// ── Real-time Audio Streaming ─────────────────────────────────────────

btnStartAudio.addEventListener("click", async () => {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });

    // Record 3-second chunks of audio
    audioRecorder = new MediaRecorder(audioStream, {
      mimeType: "audio/webm;codecs=opus",
    });

    audioRecorder.ondataavailable = async (e) => {
      if (e.data.size === 0) return;

      // Convert blob to base64
      const buffer = await e.data.arrayBuffer();
      const b64 = btoa(
        new Uint8Array(buffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ""
        )
      );

      // Send to all bots (server transcodes webm → mp3)
      try {
        await bridge.broadcastAudioWebm(b64);
      } catch {
        // Ignore audio send errors
      }
    };

    // Record in 3-second chunks
    audioRecorder.start();
    audioChunkInterval = setInterval(() => {
      if (audioRecorder && audioRecorder.state === "recording") {
        audioRecorder.stop();
        audioRecorder.start();
      }
    }, 3000);

    btnStartAudio.style.display = "none";
    btnStopAudio.style.display = "";
    statusBar.textContent = "Mic streaming started (3s chunks)";
    updateStreamInfo();
  } catch (err) {
    statusBar.textContent = `Failed to start mic: ${err.message}`;
  }
});

btnStopAudio.addEventListener("click", () => {
  if (audioChunkInterval) {
    clearInterval(audioChunkInterval);
    audioChunkInterval = null;
  }
  if (audioRecorder) {
    audioRecorder.stop();
    audioRecorder = null;
  }
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  btnStartAudio.style.display = "";
  btnStopAudio.style.display = "none";
  statusBar.textContent = "Mic streaming stopped";
  updateStreamInfo();
});
