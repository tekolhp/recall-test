import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("recallBridge", {
  // ── Feature Toggles ─────────────────────────────────────────────
  getToggles: () => ipcRenderer.invoke("get-toggles"),
  setToggle: (feature: string, enabled: boolean) =>
    ipcRenderer.invoke("set-toggle", feature, enabled),
  onToggleState: (cb: (data: any) => void) =>
    ipcRenderer.on("toggle-state", (_e, data) => cb(data)),

  // ── App Settings ────────────────────────────────────────────────
  getAppSettings: () => ipcRenderer.invoke("get-app-settings"),
  saveAppSettings: (settings: any) =>
    ipcRenderer.invoke("save-app-settings", settings),

  // ── Desktop SDK ──────────────────────────────────────────────────
  startRecording: (windowId: number) =>
    ipcRenderer.invoke("start-recording", windowId),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),
  getSources: () => ipcRenderer.invoke("get-sources"),
  getUploadStatus: (uploadId: string) =>
    ipcRenderer.invoke("get-upload-status", uploadId),
  getRecording: (recordingId: string) =>
    ipcRenderer.invoke("get-recording", recordingId),

  onMeetingDetected: (cb: (data: any) => void) =>
    ipcRenderer.on("meeting-detected", (_e, data) => cb(data)),
  onSdkStateChange: (cb: (data: any) => void) =>
    ipcRenderer.on("sdk-state-change", (_e, data) => cb(data)),
  onRecordingEnded: (cb: (data: any) => void) =>
    ipcRenderer.on("recording-ended", (_e, data) => cb(data)),
  onTranscriptData: (cb: (data: any) => void) =>
    ipcRenderer.on("transcript-data", (_e, data) => cb(data)),
  onVideoFrame: (cb: (data: any) => void) =>
    ipcRenderer.on("video-frame", (_e, data) => cb(data)),
  onParticipantEvent: (cb: (data: any) => void) =>
    ipcRenderer.on("participant-event", (_e, data) => cb(data)),

  // ── Bot Fleet ────────────────────────────────────────────────────
  deployBots: (meetingUrl: string, botCount: number, namePrefix: string) =>
    ipcRenderer.invoke("deploy-bots", meetingUrl, botCount, namePrefix),
  listBots: () => ipcRenderer.invoke("list-bots"),
  getBot: (botId: string) => ipcRenderer.invoke("get-bot", botId),
  removeBot: (botId: string) => ipcRenderer.invoke("remove-bot", botId),
  removeAllBots: () => ipcRenderer.invoke("remove-all-bots"),
  forceRemoveAllBots: () => ipcRenderer.invoke("force-remove-all-bots"),
  sendImageToBot: (botId: string, b64Data: string) =>
    ipcRenderer.invoke("send-image-to-bot", botId, b64Data),
  broadcastImage: (b64Data: string) =>
    ipcRenderer.invoke("broadcast-image", b64Data),
  // One-way fire-and-forget for streaming (no IPC round-trip)
  pushFrame: (b64Data: string) =>
    ipcRenderer.send("push-frame", b64Data),
  // Stream raw webm video chunks for HLS encoding
  streamWebmChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.send("stream-webm-chunk", Buffer.from(chunk)),
  streamStop: () =>
    ipcRenderer.send("stream-stop"),
  sendAudioToBot: (botId: string, b64Data: string) =>
    ipcRenderer.invoke("send-audio-to-bot", botId, b64Data),
  sendAudioWebmToBot: (botId: string, b64Data: string) =>
    ipcRenderer.invoke("send-audio-webm-to-bot", botId, b64Data),
  broadcastAudioWebm: (b64Data: string) =>
    ipcRenderer.invoke("broadcast-audio-webm", b64Data),
  getBotTranscript: (botId: string) =>
    ipcRenderer.invoke("get-bot-transcript", botId),
  resetSession: () => ipcRenderer.invoke("reset-session"),

  // ── Output Media (30fps webpage mode) ──────────────────────────────
  startOutputMedia: (botId: string, url: string) =>
    ipcRenderer.invoke("start-output-media", botId, url),
  stopOutputMedia: (botId: string) =>
    ipcRenderer.invoke("stop-output-media", botId),
  activateOutputMedia: () =>
    ipcRenderer.invoke("activate-output-media"),
  deactivateOutputMedia: () =>
    ipcRenderer.invoke("deactivate-output-media"),
  getTunnelInfo: () => ipcRenderer.invoke("get-tunnel-info"),
  getNgrokStatus: () => ipcRenderer.invoke("get-ngrok-status"),
  uploadVideo: (fileName: string, buffer: ArrayBuffer) =>
    ipcRenderer.invoke("upload-video", fileName, Buffer.from(buffer)),
  activateVideoOutput: (loop?: boolean) =>
    ipcRenderer.invoke("activate-video-output", loop),
  uploadMusic: (fileName: string, buffer: ArrayBuffer) =>
    ipcRenderer.invoke("upload-music", fileName, Buffer.from(buffer)),
  activateMusicOutput: (loop?: boolean) =>
    ipcRenderer.invoke("activate-music-output", loop),
  activateYouTube: (videoId: string) =>
    ipcRenderer.invoke("activate-youtube", videoId),
  pushOutputMediaFrame: (b64Data: string) =>
    ipcRenderer.invoke("push-output-media-frame", b64Data),
  openExternal: (url: string) =>
    ipcRenderer.invoke("open-external", url),
});
