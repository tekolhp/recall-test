import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("recallBridge", {
  startRecording: (windowId: number) =>
    ipcRenderer.invoke("start-recording", windowId),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),

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
});
