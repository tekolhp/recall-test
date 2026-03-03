import { app, BrowserWindow, ipcMain, systemPreferences, dialog, desktopCapturer } from "electron";
import { exec } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RecallAiSdk = require("@recallai/desktop-sdk");

const BACKEND_URL = "http://localhost:3000";

let lastDetectedMeeting: { title: string; windowId: string | null } | null = null;
let currentWindowId: string | null = null;

// ── Feature toggle state (persisted to disk) ─────────────────────────

const SETTINGS_PATH = path.join(app.getPath("userData"), "feature-toggles.json");

interface FeatureToggles {
  desktopSdk: boolean;
  botFleet: boolean;
}

function loadToggles(): FeatureToggles {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  // Both OFF by default — nothing runs, nothing bills
  return { desktopSdk: false, botFleet: false };
}

function saveToggles(toggles: FeatureToggles): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toggles, null, 2));
}

let toggles = loadToggles();
let desktopSdkInitialized = false;

// ── Desktop SDK ──────────────────────────────────────────────────────

async function requestPermissions() {
  const micStatus = systemPreferences.getMediaAccessStatus("microphone");
  if (micStatus !== "granted") {
    await systemPreferences.askForMediaAccess("microphone");
  }

  const screenStatus = systemPreferences.getMediaAccessStatus("screen");
  if (screenStatus !== "granted") {
    dialog.showMessageBoxSync({
      type: "info",
      title: "Screen Recording Permission Required",
      message: "Please enable Screen Recording for 'Recall Desktop' in System Settings.\n\nClick OK to open System Settings.",
      buttons: ["OK"],
    });
    exec("open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }

  const axTrusted = systemPreferences.isTrustedAccessibilityClient(true);
  if (!axTrusted) {
    dialog.showMessageBoxSync({
      type: "info",
      title: "Accessibility Permission Required",
      message: "Please enable Accessibility for 'Recall Desktop' in System Settings.\n\nClick OK to open System Settings.",
      buttons: ["OK"],
    });
    exec("open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  }
}

function initDesktopSdk(win: BrowserWindow) {
  if (desktopSdkInitialized) return;

  RecallAiSdk.init({ apiUrl: "https://us-west-2.recall.ai" });
  desktopSdkInitialized = true;
  console.log("[main] Desktop SDK initialized");

  RecallAiSdk.addEventListener("meeting-detected", (evt: any) => {
    if (!toggles.desktopSdk) return; // guard
    const meeting = {
      title: evt.window?.title || "Meeting detected",
      windowId: evt.window?.id ?? null,
      platform: evt.window?.platform ?? null,
    };
    currentWindowId = meeting.windowId;
    lastDetectedMeeting = meeting;
    win.webContents.send("meeting-detected", meeting);
  });

  RecallAiSdk.addEventListener("sdk-state-change", (evt: any) => {
    win.webContents.send("sdk-state-change", evt);
  });

  RecallAiSdk.addEventListener("recording-ended", (evt: any) => {
    win.webContents.send("recording-ended", evt);
  });

  RecallAiSdk.addEventListener("media-capture-status", (evt: any) => {
    console.log("[recall] Media capture status:", JSON.stringify(evt));
  });

  RecallAiSdk.addEventListener("error", (evt: any) => {
    console.error("[recall] ERROR:", JSON.stringify(evt));
    win.webContents.send("sdk-error", evt);
  });

  RecallAiSdk.addEventListener("log", (evt: any) => {
    console.log(`[recall][${evt.level}] ${evt.message}`);
  });

  RecallAiSdk.addEventListener("realtime-event", (evt: any) => {
    if (!toggles.desktopSdk) return;
    const eventName = evt.event;
    if (eventName === "transcript.data" || eventName === "transcript.partial_data") {
      win.webContents.send("transcript-data", evt.data);
    }
    if (eventName === "video_separate_png.data") {
      win.webContents.send("video-frame", evt.data);
    }
    if (eventName?.startsWith("participant_events.")) {
      win.webContents.send("participant-event", evt.data);
    }
  });
}

// ── Window ───────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.webContents.on("did-finish-load", () => {
    console.log("[main] Renderer loaded");
    // Send current toggle state to renderer
    win.webContents.send("toggle-state", toggles);
    if (lastDetectedMeeting && toggles.desktopSdk) {
      win.webContents.send("meeting-detected", lastDetectedMeeting);
    }
  });

  return win;
}

// ── App ready ────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const win = createWindow();
  console.log("[main] Window created");
  console.log(`[main] Toggles: Desktop SDK=${toggles.desktopSdk}, Bot Fleet=${toggles.botFleet}`);

  // Init Desktop SDK only if enabled
  if (toggles.desktopSdk) {
    await requestPermissions();
    initDesktopSdk(win);
  }

  // ── Toggle IPC ────────────────────────────────────────────────────

  ipcMain.handle("get-toggles", () => toggles);

  ipcMain.handle("set-toggle", async (_event, feature: string, enabled: boolean) => {
    if (feature === "desktopSdk") {
      toggles.desktopSdk = enabled;
      if (enabled && !desktopSdkInitialized) {
        await requestPermissions();
        initDesktopSdk(win);
      }
      if (!enabled && currentWindowId) {
        // Stop any active recording
        try {
          await RecallAiSdk.stopRecording({ windowId: currentWindowId });
        } catch {}
        currentWindowId = null;
        lastDetectedMeeting = null;
      }
      console.log(`[main] Desktop SDK ${enabled ? "ENABLED" : "DISABLED"}`);
    }

    if (feature === "botFleet") {
      toggles.botFleet = enabled;
      if (!enabled) {
        // Force remove all bots when disabling
        try {
          await fetch(`${BACKEND_URL}/api/bots/force-remove-all`, {
            method: "POST",
          });
          console.log("[main] Bot Fleet DISABLED — all bots force removed");
        } catch (err: any) {
          console.error("[main] Failed to force remove bots:", err.message);
        }
      } else {
        console.log("[main] Bot Fleet ENABLED");
      }
    }

    saveToggles(toggles);
    win.webContents.send("toggle-state", toggles);
    return toggles;
  });

  // ── Desktop SDK IPC ───────────────────────────────────────────────

  ipcMain.handle("start-recording", async (_event, windowId: string) => {
    if (!toggles.desktopSdk) return { ok: false, error: "Desktop SDK is disabled" };
    try {
      const res = await fetch(`${BACKEND_URL}/api/create-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const { upload_token, upload_id } = await res.json();
      await RecallAiSdk.startRecording({ windowId, uploadToken: upload_token });
      return { ok: true, uploadId: upload_id };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("stop-recording", async () => {
    if (!toggles.desktopSdk) return { ok: false, error: "Desktop SDK is disabled" };
    try {
      if (currentWindowId) {
        await RecallAiSdk.stopRecording({ windowId: currentWindowId });
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("get-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.map((s) => ({ id: s.id, name: s.name }));
  });

  ipcMain.handle("get-upload-status", async (_event, uploadId: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/upload-status/${uploadId}`);
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("get-recording", async (_event, recordingId: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/recording/${recordingId}`);
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // ── Bot Fleet IPC ─────────────────────────────────────────────────

  ipcMain.handle("deploy-bots", async (_event, meetingUrl: string, botCount: number, namePrefix: string) => {
    if (!toggles.botFleet) return { error: "Bot Fleet is disabled" };
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_url: meetingUrl, bot_count: botCount, bot_name_prefix: namePrefix }),
      });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("list-bots", async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots`);
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("get-bot", async (_event, botId: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/${botId}`);
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("remove-bot", async (_event, botId: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/${botId}/leave`, { method: "POST" });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("remove-all-bots", async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/remove-all`, { method: "POST" });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("force-remove-all-bots", async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/force-remove-all`, { method: "POST" });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("send-image-to-bot", async (_event, botId: string, b64Data: string) => {
    if (!toggles.botFleet) return { error: "Bot Fleet is disabled" };
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/${botId}/send-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ b64_data: b64Data }),
      });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("broadcast-image", async (_event, b64Data: string) => {
    if (!toggles.botFleet) return { error: "Bot Fleet is disabled" };
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/broadcast-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ b64_data: b64Data }),
      });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // One-way frame push (legacy)
  ipcMain.on("push-frame", (_event, b64Data: string) => {
    if (!toggles.botFleet) return;
    fetch(`${BACKEND_URL}/api/output-media/frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ b64_data: b64Data }),
    }).catch(() => {});
  });

  // Stream raw webm chunks to server for HLS encoding (one-way, fire-and-forget)
  ipcMain.on("stream-webm-chunk", (_event, chunk: any) => {
    if (!toggles.botFleet) return;
    // Ensure proper Buffer (IPC may serialize as Uint8Array)
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    fetch(`${BACKEND_URL}/api/output-media/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    }).catch(() => {});
  });

  ipcMain.on("stream-stop", () => {
    fetch(`${BACKEND_URL}/api/output-media/stream-stop`, { method: "POST" }).catch(() => {});
  });

  ipcMain.handle("send-audio-to-bot", async (_event, botId: string, b64Data: string) => {
    if (!toggles.botFleet) return { error: "Bot Fleet is disabled" };
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/${botId}/send-audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ b64_data: b64Data }),
      });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("send-audio-webm-to-bot", async (_event, botId: string, b64Data: string) => {
    if (!toggles.botFleet) return { error: "Bot Fleet is disabled" };
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/${botId}/send-audio-webm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ b64_data: b64Data }),
      });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("broadcast-audio-webm", async (_event, b64Data: string) => {
    if (!toggles.botFleet) return { error: "Bot Fleet is disabled" };
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/broadcast-audio-webm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ b64_data: b64Data }),
      });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  ipcMain.handle("get-bot-transcript", async (_event, botId: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/bots/${botId}/transcript`);
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // ── Output Media (30fps webpage mode) ──────────────────────────────

  ipcMain.handle("get-ngrok-status", async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/ngrok-status`);
      return await res.json();
    } catch (err: any) {
      return { available: false, error: err.message };
    }
  });

  ipcMain.handle("push-output-media-frame", async (_event, b64Data: string) => {
    if (!toggles.botFleet) return { error: "Bot Fleet is disabled" };
    try {
      const res = await fetch(`${BACKEND_URL}/api/output-media/frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ b64_data: b64Data }),
      });
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
