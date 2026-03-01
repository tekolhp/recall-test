import { app, BrowserWindow, ipcMain, systemPreferences, dialog } from "electron";
import { exec } from "node:child_process";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RecallAiSdk = require("@recallai/desktop-sdk");

const BACKEND_URL = "http://localhost:3000";

let lastDetectedMeeting: { title: string; windowId: string | null } | null = null;
let currentWindowId: string | null = null;

async function requestPermissions() {
  // Microphone — this one shows a native dialog
  const micStatus = systemPreferences.getMediaAccessStatus("microphone");
  console.log("[perms] Microphone:", micStatus);
  if (micStatus !== "granted") {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    console.log("[perms] Microphone granted:", granted);
  }

  // Screen capture — check and open System Settings if needed
  const screenStatus = systemPreferences.getMediaAccessStatus("screen");
  console.log("[perms] Screen capture:", screenStatus);
  if (screenStatus !== "granted") {
    dialog.showMessageBoxSync({
      type: "info",
      title: "Screen Recording Permission Required",
      message: "Please enable Screen Recording for 'Recall Desktop' in System Settings.\n\nClick OK to open System Settings.",
      buttons: ["OK"],
    });
    exec("open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }

  // Accessibility — check and open System Settings if needed
  const axTrusted = systemPreferences.isTrustedAccessibilityClient(true);
  console.log("[perms] Accessibility trusted:", axTrusted);
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

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.webContents.on("did-finish-load", () => {
    console.log("[main] Renderer loaded");
    if (lastDetectedMeeting) {
      console.log("[main] Sending queued meeting to renderer");
      win.webContents.send("meeting-detected", lastDetectedMeeting);
    }
  });

  return win;
}

app.whenReady().then(async () => {
  const win = createWindow();
  console.log("[main] Window created");

  // Request macOS permissions with native dialogs
  await requestPermissions();

  RecallAiSdk.init({
    apiUrl: "https://us-west-2.recall.ai",
  });

  // Meeting detected
  RecallAiSdk.addEventListener("meeting-detected", (evt: any) => {
    console.log("[recall] Meeting detected:", JSON.stringify(evt));
    const meeting = {
      title: evt.window?.title || "Meeting detected",
      windowId: evt.window?.id ?? null,
    };
    currentWindowId = meeting.windowId;
    lastDetectedMeeting = meeting;
    win.webContents.send("meeting-detected", meeting);
  });

  // SDK state changes
  RecallAiSdk.addEventListener("sdk-state-change", (evt: any) => {
    console.log("[recall] SDK state changed:", JSON.stringify(evt));
    win.webContents.send("sdk-state-change", evt);
  });

  // Recording ended
  RecallAiSdk.addEventListener("recording-ended", (evt: any) => {
    console.log("[recall] Recording ended:", JSON.stringify(evt));
    win.webContents.send("recording-ended", evt);
  });

  // Media capture status (video/audio capturing started/stopped)
  RecallAiSdk.addEventListener("media-capture-status", (evt: any) => {
    console.log("[recall] Media capture status:", JSON.stringify(evt));
  });

  // Participant capture status
  RecallAiSdk.addEventListener("participant-capture-status", (evt: any) => {
    console.log("[recall] Participant capture:", JSON.stringify(evt));
  });

  // Errors
  RecallAiSdk.addEventListener("error", (evt: any) => {
    console.error("[recall] ERROR:", JSON.stringify(evt));
    win.webContents.send("sdk-error", evt);
  });

  // Log events from SDK
  RecallAiSdk.addEventListener("log", (evt: any) => {
    console.log(`[recall][${evt.level}] ${evt.message}`);
  });

  // Real-time events — payload uses `event` field, not `type`
  RecallAiSdk.addEventListener("realtime-event", (evt: any) => {
    const eventName = evt.event;
    console.log("[recall] Realtime event:", eventName);

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

  // IPC: Start recording
  ipcMain.handle("start-recording", async (_event, windowId: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/create-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const { upload_token, upload_id } = await res.json();

      await RecallAiSdk.startRecording({
        windowId,
        uploadToken: upload_token,
      });

      console.log(`[recall] Recording started (upload: ${upload_id})`);
      return { ok: true, uploadId: upload_id };
    } catch (err: any) {
      console.error("[recall] Failed to start recording:", err);
      return { ok: false, error: err.message };
    }
  });

  // IPC: Stop recording
  ipcMain.handle("stop-recording", async () => {
    try {
      if (currentWindowId) {
        await RecallAiSdk.stopRecording({ windowId: currentWindowId });
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
