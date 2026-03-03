import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("recallBridge", {
  // ── Feature Toggles ─────────────────────────────────────────────
  getToggles: () => ipcRenderer.invoke("get-toggles"),
  setToggle: (feature: string, enabled: boolean) =>
    ipcRenderer.invoke("set-toggle", feature, enabled),
  onToggleState: (cb: (data: any) => void) =>
    ipcRenderer.on("toggle-state", (_e, data) => cb(data)),

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

  // ── Output Media (30fps webpage mode) ──────────────────────────────
  getNgrokStatus: () => ipcRenderer.invoke("get-ngrok-status"),
  pushOutputMediaFrame: (b64Data: string) =>
    ipcRenderer.invoke("push-output-media-frame", b64Data),
});
