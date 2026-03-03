import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import NodeMediaServer from "node-media-server";

const app = express();
app.use(express.json({ limit: "5mb" }));

const API_KEY = process.env.RECALL_API_KEY!;
const REGION = process.env.RECALL_REGION || "us-west-2";
const BASE_URL = `https://${REGION}.recall.ai`;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!API_KEY) {
  console.error("Missing RECALL_API_KEY in .env");
  process.exit(1);
}

// ── Bypass ngrok interstitial for all responses ─────────────────────
app.use((_req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

// ── Bot fleet state ──────────────────────────────────────────────────

interface BotRecord {
  id: string;
  recallBotId: string;
  name: string;
  status: string;
  breakoutRoom: string | null;
  meetingUrl: string;
  createdAt: string;
}

const bots = new Map<string, BotRecord>();
let botCounter = 0; // Global counter for unique bot IDs across deploys

// 1-pixel silent JPEG for enabling automatic_video_output (API fallback)
const SILENT_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=";

// Minimal silent MP3 (required to enable output_audio endpoint)
const SILENT_MP3 =
  "//uQxAAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

// ── Tunnel management (ngrok + cloudflared) ─────────────────────────

let ngrokTcpUrl: string | null = null; // for RTMP streaming
let tunnelHttpUrl: string | null = null; // for output media (cloudflared)

import { spawn } from "node:child_process";

function startCloudflared(): Promise<string | null> {
  return new Promise((resolve) => {
    const cf = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(null); }
    }, 15000);

    function parseLine(line: string) {
      const match = line.match(/(https:\/\/[^\s]*\.trycloudflare\.com)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelHttpUrl = match[1];
        console.log(`[cloudflared] Tunnel ready: ${tunnelHttpUrl}`);
        resolve(tunnelHttpUrl);
      }
    }

    cf.stdout.on("data", (d: Buffer) => d.toString().split("\n").forEach(parseLine));
    cf.stderr.on("data", (d: Buffer) => d.toString().split("\n").forEach(parseLine));

    cf.on("exit", (code) => {
      console.log(`[cloudflared] Process exited (code ${code})`);
      tunnelHttpUrl = null;
    });
  });
}

async function detectTunnels(): Promise<void> {
  // Detect ngrok tunnels (for RTMP TCP)
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    const data = await res.json();
    const tunnels = (data.tunnels as any[]) || [];

    const tcpTunnel = tunnels.find((t: any) => t.proto === "tcp");
    if (tcpTunnel) {
      ngrokTcpUrl = tcpTunnel.public_url;
      console.log(`[server] Detected ngrok TCP: ${ngrokTcpUrl}`);
    } else {
      ngrokTcpUrl = null;
    }
  } catch {
    ngrokTcpUrl = null;
  }

  // Use env var if provided, otherwise cloudflared is started automatically
  if (process.env.CLOUDFLARED_URL) {
    tunnelHttpUrl = process.env.CLOUDFLARED_URL;
    console.log(`[server] Using cloudflared (env): ${tunnelHttpUrl}`);
  }
}

app.get("/api/ngrok-status", async (_req, res) => {
  await detectTunnels();
  res.json({
    available: !!tunnelHttpUrl,
    url: tunnelHttpUrl,
    rtmpAvailable: !!ngrokTcpUrl,
    rtmpUrl: ngrokTcpUrl,
  });
});

// ── WebSocket server for Output Media pages ─────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/output-media" });

// Separate WebSocket for the renderer to push frames directly (no HTTP overhead)
const wssPush = new WebSocketServer({ server, path: "/ws/frame-push" });

wssPush.on("connection", (ws) => {
  console.log("[ws] Frame push client connected (renderer)");

  ws.on("message", (data: Buffer) => {
    // Received binary JPEG frame from renderer
    lastFrame = data;
    latestFrameB64 = data.toString("base64");
    latestFrameVersion++;

    // Push to SSE clients (bot's headless browser) — instant delivery
    pushFrameToSSE(latestFrameB64);

    // Push to WebSocket clients
    for (const [, clients] of outputMediaClients) {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    }
  });

  ws.on("close", () => {
    console.log("[ws] Frame push client disconnected");
  });
});

const outputMediaClients = new Map<string, Set<WebSocket>>();

wss.on("connection", (ws, req) => {
  const url = new URL(req.url!, `http://localhost`);
  const botId = url.searchParams.get("bot") || "unknown";

  if (!outputMediaClients.has(botId)) {
    outputMediaClients.set(botId, new Set());
  }
  outputMediaClients.get(botId)!.add(ws);

  console.log(`[ws] Output media page connected for bot: ${botId}`);

  // Send current static frame if one exists
  if (lastFrame) {
    ws.send(lastFrame);
  }

  ws.on("close", () => {
    outputMediaClients.get(botId)?.delete(ws);
    if (outputMediaClients.get(botId)?.size === 0) {
      outputMediaClients.delete(botId);
    }
    console.log(`[ws] Output media page disconnected for bot: ${botId}`);
  });
});

// Last frame buffer for new connections
let lastFrame: Buffer | null = null;

// Frame store for HTTP polling (output media page)
let latestFrameB64: string | null = null;
let latestFrameVersion = 0;

function broadcastToOutputMediaPages(frame: Buffer) {
  lastFrame = frame;
  for (const [, clients] of outputMediaClients) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }
}

function getConnectedClientCount(): number {
  let count = 0;
  for (const [, clients] of outputMediaClients) {
    count += clients.size;
  }
  return count;
}

// ── Output Media HTML page (rendered by bot's headless browser) ─────

// Uses Server-Sent Events (SSE) for instant frame delivery — no polling delay
// Output media page: plays HLS stream (smooth 30fps video via real encoding)
const OUTPUT_MEDIA_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<style>
  * { margin: 0; padding: 0; }
  body { width: 1280px; height: 720px; overflow: hidden; background: #000; }
  video { width: 1280px; height: 720px; object-fit: cover; }
</style>
</head><body>
<video id="v" muted autoplay playsinline></video>
<script>
const video = document.getElementById('v');
const hlsUrl = '/hls/webcam/index.m3u8';

function startHls() {
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls({
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 2,
      maxBufferLength: 2,
      enableWorker: true,
    });
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        setTimeout(() => { hls.destroy(); startHls(); }, 2000);
      }
    });
  } else {
    // Fallback: native HLS (Safari)
    video.src = hlsUrl;
    video.play();
  }
}

// Wait for HLS stream to be available
function tryStart() {
  fetch(hlsUrl).then(r => {
    if (r.ok) startHls();
    else setTimeout(tryStart, 1000);
  }).catch(() => setTimeout(tryStart, 1000));
}
tryStart();
</script>
</body></html>`;

app.get("/output-media", (_req, res) => {
  res.type("html").send(OUTPUT_MEDIA_HTML);
});

// ── Live HLS encoding from webcam ───────────────────────────────────

import { mkdirSync, existsSync } from "node:fs";

const HLS_DIR = path.join(process.cwd(), "media", "webcam");
if (!existsSync(HLS_DIR)) mkdirSync(HLS_DIR, { recursive: true });

// Serve HLS segments
app.use("/hls/webcam", express.static(HLS_DIR, {
  setHeaders: (res) => {
    res.set("Cache-Control", "no-cache, no-store");
    res.set("Access-Control-Allow-Origin", "*");
  },
}));

// ffmpeg process for live encoding
let ffmpegProc: ReturnType<typeof spawn> | null = null;

function startFfmpegHls() {
  if (ffmpegProc) return;

  // Clean old segments
  const files = require("node:fs").readdirSync(HLS_DIR);
  for (const f of files) {
    require("node:fs").unlinkSync(path.join(HLS_DIR, f));
  }

  ffmpegProc = spawn("/opt/homebrew/bin/ffmpeg", [
    "-f", "webm",
    "-i", "pipe:0",           // Read webm from stdin
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-g", "30",               // Keyframe every 30 frames
    "-sc_threshold", "0",
    "-b:v", "1500k",
    "-maxrate", "1500k",
    "-bufsize", "3000k",
    "-s", "1280x720",
    "-r", "30",
    "-f", "hls",
    "-hls_time", "1",         // 1-second segments
    "-hls_list_size", "3",
    "-hls_flags", "delete_segments+append_list",
    "-hls_segment_filename", path.join(HLS_DIR, "seg%03d.ts"),
    path.join(HLS_DIR, "index.m3u8"),
  ], { stdio: ["pipe", "pipe", "pipe"] });

  ffmpegProc.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[ffmpeg] ${msg}`);
  });

  ffmpegProc.on("exit", (code) => {
    console.log(`[ffmpeg] HLS encoder exited (code ${code})`);
    ffmpegProc = null;
  });

  console.log("[ffmpeg] HLS encoder started (1s segments, 1280x720, 30fps)");
}

function stopFfmpegHls() {
  if (ffmpegProc) {
    ffmpegProc.stdin?.end();
    ffmpegProc.kill();
    ffmpegProc = null;
    console.log("[ffmpeg] HLS encoder stopped");
  }
}

// Receive webm video chunks from renderer and pipe to ffmpeg
app.post("/api/output-media/stream", express.raw({ type: "*/*", limit: "5mb" }), (req, res) => {
  if (!ffmpegProc) startFfmpegHls();

  try {
    if (ffmpegProc?.stdin?.writable) {
      ffmpegProc.stdin.write(req.body);
    }
  } catch {}

  res.json({ ok: true });
});

app.post("/api/output-media/stream-stop", (_req, res) => {
  stopFfmpegHls();
  res.json({ ok: true });
});

// ── Output Media SSE + frame endpoints ──────────────────────────────

// SSE clients (bot's headless browser connects here for instant frame push)
const sseClients = new Set<any>();

app.get("/api/output-media/sse", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "ngrok-skip-browser-warning": "true",
  });
  res.write("\n");
  sseClients.add(res);
  console.log(`[sse] Output media client connected (${sseClients.size} total)`);

  // Send current frame immediately if one exists
  if (latestFrameB64) {
    res.write(`data: ${latestFrameB64}\n\n`);
  }

  req.on("close", () => {
    sseClients.delete(res);
    console.log(`[sse] Output media client disconnected (${sseClients.size} total)`);
  });
});

function pushFrameToSSE(b64: string) {
  const msg = `data: ${b64}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

app.post("/api/output-media/frame", (req, res) => {
  const { b64_data } = req.body;
  if (!b64_data) {
    res.status(400).json({ error: "b64_data is required" });
    return;
  }

  latestFrameB64 = b64_data;
  latestFrameVersion++;

  // Push to SSE clients (bot's headless browser) — instant delivery
  pushFrameToSSE(b64_data);

  // Also push via WebSocket for local renderer preview
  const frame = Buffer.from(b64_data, "base64");
  broadcastToOutputMediaPages(frame);

  res.json({ ok: true, version: latestFrameVersion, sseClients: sseClients.size });
});

app.get("/api/output-media/latest", (_req, res) => {
  res.json({
    version: latestFrameVersion,
    b64_data: latestFrameB64,
  });
});

// ── Desktop SDK Endpoints ────────────────────────────────────────────

app.post("/api/create-upload", async (_req, res) => {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/sdk_upload/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recording_config: {
          realtime_endpoints: [
            {
              type: "desktop_sdk_callback",
              events: [
                "participant_events.join",
                "participant_events.speech_on",
                "participant_events.speech_off",
                "video_separate_png.data",
              ],
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[server] Recall API error (${response.status}): ${text}`);
      res.status(502).json({ error: "Failed to create upload" });
      return;
    }

    const data = await response.json();
    console.log(`[server] Created SDK upload: ${data.id}`);

    res.json({
      upload_id: data.id,
      upload_token: data.upload_token,
    });
  } catch (err) {
    console.error("[server] Error creating upload:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/webhooks/recall", async (req, res) => {
  const { event, data } = req.body;
  console.log(`[webhook] Received: ${event}`);

  if (event === "sdk_upload.complete") {
    const recordingId = data?.recording?.id;
    console.log(`[webhook] Upload complete! Recording ID: ${recordingId}`);

    if (recordingId) {
      try {
        const response = await fetch(
          `${BASE_URL}/api/v1/recording/${recordingId}/`,
          { headers: { Authorization: `Token ${API_KEY}` } }
        );
        const recording = await response.json();
        console.log(
          "[webhook] Recording details:",
          JSON.stringify(recording, null, 2)
        );
      } catch (err) {
        console.error("[webhook] Error fetching recording:", err);
      }
    }
  }

  if (event === "sdk_upload.failed") {
    console.error("[webhook] Upload failed:", data);
  }

  // Bot status webhooks
  const botEvents = [
    "bot.joining_call",
    "bot.in_waiting_room",
    "bot.in_call_not_recording",
    "bot.in_call_recording",
    "bot.call_ended",
    "bot.done",
    "bot.fatal",
    "bot.recording_permission_allowed",
    "bot.recording_permission_denied",
  ];

  if (botEvents.includes(event)) {
    const recallBotId = data?.bot_id || data?.id;
    const status = event.replace("bot.", "");
    console.log(`[webhook] Bot ${recallBotId}: ${status}`);

    for (const bot of bots.values()) {
      if (bot.recallBotId === recallBotId) {
        bot.status = status;
        break;
      }
    }
  }

  if (event === "bot.breakout_room_entered") {
    const recallBotId = data?.bot_id || data?.id;
    const roomName = data?.breakout_room?.name || "Unknown Room";
    console.log(
      `[webhook] Bot ${recallBotId} entered breakout room: ${roomName}`
    );
    for (const bot of bots.values()) {
      if (bot.recallBotId === recallBotId) {
        bot.breakoutRoom = roomName;
        bot.status = "in_breakout_room";
        break;
      }
    }
  }

  if (event === "bot.breakout_room_left") {
    const recallBotId = data?.bot_id || data?.id;
    for (const bot of bots.values()) {
      if (bot.recallBotId === recallBotId) {
        bot.breakoutRoom = null;
        bot.status = "in_call_recording";
        break;
      }
    }
  }

  res.json({ ok: true });
});

// ── Bot Fleet Endpoints ──────────────────────────────────────────────

app.post("/api/bots/deploy", async (req, res) => {
  const {
    meeting_url,
    bot_count = 1,
    bot_name_prefix = "Helper",
  } = req.body;

  if (!meeting_url) {
    res.status(400).json({ error: "meeting_url is required" });
    return;
  }

  // Re-detect all tunnels before deploying
  await detectTunnels();

  // Remove any existing bots from calls before deploying new ones
  for (const bot of bots.values()) {
    if (!["done", "fatal", "leaving"].includes(bot.status)) {
      try {
        await fetch(`${BASE_URL}/api/v1/bot/${bot.recallBotId}/leave_call/`, {
          method: "POST", headers: { Authorization: `Token ${API_KEY}` },
        });
      } catch {}
    }
  }
  bots.clear();
  botCounter = 0;

  const count = Math.min(Math.max(1, bot_count), 10);
  const created: BotRecord[] = [];
  const errors: { index: number; error: string }[] = [];

  for (let i = 1; i <= count; i++) {
    botCounter++;
    const localId = `bot-${botCounter}`;

    const botPayload: any = {
      meeting_url,
      bot_name: `${bot_name_prefix} ${i}`,
      recording_config: {
        transcript: {
          provider: { meeting_captions: {} },
        },
      },
      zoom: {
        breakout_room_handling: "auto_accept_all_invites",
      },
    };

    // RTMP streaming: receive live 720p/30fps video from the meeting
    if (ngrokTcpUrl) {
      // Convert tcp://host:port to rtmp://host:port/live/bot-{i}
      const rtmpUrl = ngrokTcpUrl.replace("tcp://", "rtmp://") + `/live/${localId}`;
      botPayload.recording_config.video_mixed_flv = {};
      botPayload.recording_config.realtime_endpoints = [
        {
          type: "rtmp",
          url: rtmpUrl,
          events: ["video_mixed_flv.data"],
        },
      ];
      console.log(`[bot] ${localId} RTMP stream → ${rtmpUrl}`);
    }

    // Output media webpage (30fps via cloudflared)
    if (tunnelHttpUrl) {
      botPayload.output_media = {
        camera: {
          kind: "webpage",
          config: {
            url: `${tunnelHttpUrl}/output-media?bot=${localId}`,
          },
        },
      };
      console.log(`[bot] ${localId} camera: webpage via ${tunnelHttpUrl}`);
    } else {
      console.log(`[bot] ${localId} WARNING: no tunnel — bot camera will be black`);
    }
    botPayload.automatic_audio_output = {
      in_call_recording: {
        data: { kind: "mp3" as const, b64_data: SILENT_MP3 },
      },
    };

    try {
      const response = await fetch(`${BASE_URL}/api/v1/bot/`, {
        method: "POST",
        headers: {
          Authorization: `Token ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(botPayload),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(
          `[bot] Failed to create ${localId} (${response.status}): ${text}`
        );
        errors.push({ index: i, error: text });
        continue;
      }

      const data = await response.json();
      const record: BotRecord = {
        id: localId,
        recallBotId: data.id,
        name: `${bot_name_prefix} ${i}`,
        status: "joining_call",
        breakoutRoom: null,
        meetingUrl: meeting_url,
        createdAt: new Date().toISOString(),
      };

      bots.set(localId, record);
      created.push(record);
      console.log(`[bot] Created ${localId} → Recall bot ${data.id}`);
    } catch (err: any) {
      console.error(`[bot] Error creating ${localId}:`, err.message);
      errors.push({ index: i, error: err.message });
    }
  }

  res.json({ created, errors, mode: tunnelHttpUrl ? "webpage" : "api" });
});

app.get("/api/bots", async (_req, res) => {
  for (const bot of bots.values()) {
    if (["done", "fatal"].includes(bot.status)) continue;

    try {
      const response = await fetch(
        `${BASE_URL}/api/v1/bot/${bot.recallBotId}/`,
        { headers: { Authorization: `Token ${API_KEY}` } }
      );
      if (response.ok) {
        const data = await response.json();
        const latest =
          data.status_changes?.[data.status_changes.length - 1];
        if (latest) {
          bot.status = latest.code?.replace("bot.", "") || bot.status;
        }
      }
    } catch {
      // Use cached status
    }
  }

  res.json(Array.from(bots.values()));
});

app.get("/api/bots/:id", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/bot/${bot.recallBotId}/`,
      { headers: { Authorization: `Token ${API_KEY}` } }
    );

    if (!response.ok) {
      res.json(bot);
      return;
    }

    const data = await response.json();
    const latest = data.status_changes?.[data.status_changes.length - 1];
    if (latest) {
      bot.status = latest.code?.replace("bot.", "") || bot.status;
    }

    res.json({ ...bot, recall_data: data });
  } catch {
    res.json(bot);
  }
});

app.post("/api/bots/:id/leave", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/bot/${bot.recallBotId}/leave_call/`,
      {
        method: "POST",
        headers: { Authorization: `Token ${API_KEY}` },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      res.status(502).json({ error: text });
      return;
    }

    bot.status = "leaving";
    console.log(`[bot] ${bot.id} leaving call`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bots/remove-all", async (_req, res) => {
  const results: { id: string; ok: boolean; error?: string }[] = [];

  for (const bot of bots.values()) {
    if (["done", "fatal", "leaving"].includes(bot.status)) continue;

    try {
      await fetch(
        `${BASE_URL}/api/v1/bot/${bot.recallBotId}/leave_call/`,
        {
          method: "POST",
          headers: { Authorization: `Token ${API_KEY}` },
        }
      );
      bot.status = "leaving";
      results.push({ id: bot.id, ok: true });
    } catch (err: any) {
      results.push({ id: bot.id, ok: false, error: err.message });
    }
  }

  res.json({ results });
});

app.post("/api/bots/force-remove-all", async (_req, res) => {
  const removed: string[] = [];
  const errors: { id: string; error: string }[] = [];

  try {
    const activeStatuses = [
      "joining_call",
      "in_waiting_room",
      "in_call_not_recording",
      "in_call_recording",
      "recording_permission_allowed",
    ];

    for (const status of activeStatuses) {
      try {
        const listRes = await fetch(
          `${BASE_URL}/api/v1/bot/?status_code=${status}&limit=100`,
          { headers: { Authorization: `Token ${API_KEY}` } }
        );

        if (!listRes.ok) continue;

        const data = await listRes.json();
        const results = data.results || data || [];

        for (const bot of results) {
          try {
            await fetch(
              `${BASE_URL}/api/v1/bot/${bot.id}/leave_call/`,
              {
                method: "POST",
                headers: { Authorization: `Token ${API_KEY}` },
              }
            );
            removed.push(`${bot.bot_name} (${bot.id})`);
            console.log(`[bot] Force removed: ${bot.bot_name} (${bot.id})`);
          } catch (err: any) {
            errors.push({ id: bot.id, error: err.message });
          }
        }
      } catch {
        // Skip this status query
      }
    }

    bots.clear();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }

  res.json({ removed, errors, total: removed.length });
});

// ── Bot image/audio endpoints ────────────────────────────────────────

app.post("/api/bots/:id/send-image", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  const { b64_data } = req.body;
  if (!b64_data) {
    res.status(400).json({ error: "b64_data is required" });
    return;
  }

  // Push to SSE (output_media webpage renders it as bot's camera)
  pushFrameToSSE(b64_data);
  latestFrameB64 = b64_data;
  latestFrameVersion++;
  res.json({ ok: true, sseClients: sseClients.size });
});

// Keep old output_video route for backwards compat but unused
app.post("/api/bots/:id/send-image-api", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) { res.status(404).json({ error: "Bot not found" }); return; }
  const { b64_data } = req.body;
  if (!b64_data) { res.status(400).json({ error: "b64_data is required" }); return; }
  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_video/`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind: "jpeg", b64_data }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`[bot] output_video failed for ${bot.id}: ${text}`);
      res.status(502).json({ error: text });
      return;
    }

    res.json({ ok: true, mode: "api" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bots/broadcast-image", async (req, res) => {
  const { b64_data } = req.body;
  if (!b64_data) {
    res.status(400).json({ error: "b64_data is required" });
    return;
  }

  // Push to SSE — all bot output_media pages receive this instantly
  pushFrameToSSE(b64_data);
  latestFrameB64 = b64_data;
  latestFrameVersion++;

  res.json({ ok: true, sseClients: sseClients.size, mode: "webpage" });
});

app.post("/api/bots/:id/send-audio", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  const { b64_data } = req.body;
  if (!b64_data) {
    res.status(400).json({ error: "b64_data is required" });
    return;
  }

  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_audio/`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: { kind: "mp3", b64_data } }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`[bot] output_audio failed for ${bot.id}: ${text}`);
      res.status(502).json({ error: text });
      return;
    }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bots/:id/send-audio-webm", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  const { b64_data } = req.body;
  if (!b64_data) {
    res.status(400).json({ error: "b64_data is required" });
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const webmPath = path.join(tmpdir(), `recall-${id}.webm`);
  const mp3Path = path.join(tmpdir(), `recall-${id}.mp3`);

  try {
    await writeFile(webmPath, Buffer.from(b64_data, "base64"));

    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-i", webmPath, "-codec:a", "libmp3lame", "-b:a", "64k", "-y", mp3Path],
        { timeout: 10000 },
        (err) => (err ? reject(err) : resolve())
      );
    });

    const mp3Buffer = await readFile(mp3Path);
    const mp3B64 = mp3Buffer.toString("base64");

    const response = await fetch(
      `${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_audio/`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: { kind: "mp3", b64_data: mp3B64 } }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      res.status(502).json({ error: text });
      return;
    }

    res.json({ ok: true });
  } catch (err: any) {
    console.error(`[bot] audio transcode failed for ${bot.id}:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    unlink(webmPath).catch(() => {});
    unlink(mp3Path).catch(() => {});
  }
});

app.post("/api/bots/broadcast-audio-webm", async (req, res) => {
  const { b64_data } = req.body;
  if (!b64_data) {
    res.status(400).json({ error: "b64_data is required" });
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const webmPath = path.join(tmpdir(), `recall-${id}.webm`);
  const mp3Path = path.join(tmpdir(), `recall-${id}.mp3`);

  try {
    await writeFile(webmPath, Buffer.from(b64_data, "base64"));

    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-i", webmPath, "-codec:a", "libmp3lame", "-b:a", "64k", "-y", mp3Path],
        { timeout: 10000 },
        (err) => (err ? reject(err) : resolve())
      );
    });

    const mp3Buffer = await readFile(mp3Path);
    const mp3B64 = mp3Buffer.toString("base64");

    const activeBotList = Array.from(bots.values()).filter(
      (b) => !["done", "fatal", "leaving"].includes(b.status)
    );

    const body = JSON.stringify({ data: { kind: "mp3", b64_data: mp3B64 } });
    const results = await Promise.allSettled(
      activeBotList.map((bot) =>
        fetch(`${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_audio/`, {
          method: "POST",
          headers: {
            Authorization: `Token ${API_KEY}`,
            "Content-Type": "application/json",
          },
          body,
        }).then((r) => r.ok)
      )
    );

    const sent = results.filter((r) => r.status === "fulfilled" && r.value).length;
    const failed = results.length - sent;

    res.json({ ok: true, sent, failed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    unlink(webmPath).catch(() => {});
    unlink(mp3Path).catch(() => {});
  }
});

app.get("/api/bots/:id/transcript", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/bot/${bot.recallBotId}/transcript/`,
      { headers: { Authorization: `Token ${API_KEY}` } }
    );

    if (!response.ok) {
      res.status(response.status).json({ error: "Transcript not available yet" });
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Existing Desktop SDK Endpoints ───────────────────────────────────

app.get("/api/recording/:id", async (req, res) => {
  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/recording/${req.params.id}/`,
      { headers: { Authorization: `Token ${API_KEY}` } }
    );

    if (!response.ok) {
      res.status(response.status).json({ error: "Not found" });
      return;
    }

    res.json(await response.json());
  } catch (err) {
    console.error("[server] Error fetching recording:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/upload-status/:id", async (req, res) => {
  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/sdk_upload/${req.params.id}/`,
      { headers: { Authorization: `Token ${API_KEY}` } }
    );

    if (!response.ok) {
      res.status(response.status).json({ error: "Not found" });
      return;
    }

    res.json(await response.json());
  } catch (err) {
    console.error("[server] Error fetching upload status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── RTMP ingest server (node-media-server) ──────────────────────────

const nms = new NodeMediaServer({
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: 8000,
    mediaroot: "./media",
    allow_origin: "*",
  },
  trans: {
    ffmpeg: "/opt/homebrew/bin/ffmpeg",
    tasks: [
      {
        app: "live",
        hls: 1,
        hlsFlags: "[hls_time=2:hls_list_size=3:hls_flags=delete_segments]",
      },
    ],
  },
});

nms.on("prePublish", (_id: string, StreamPath: string) => {
  console.log(`[rtmp] Stream started: ${StreamPath}`);
});

nms.on("donePublish", (_id: string, StreamPath: string) => {
  console.log(`[rtmp] Stream ended: ${StreamPath}`);
});

// ── Start servers ────────────────────────────────────────────────────

// ── Force remove all active bots (used on startup and shutdown) ─────

async function forceRemoveAllBots() {
  const statuses = ["joining_call", "in_waiting_room", "in_call_not_recording", "in_call_recording", "recording_permission_allowed"];
  let total = 0;
  for (const s of statuses) {
    try {
      const listRes = await fetch(`${BASE_URL}/api/v1/bot/?status_code=${s}&limit=100`, {
        headers: { Authorization: `Token ${API_KEY}` },
      });
      if (!listRes.ok) continue;
      const data = await listRes.json();
      for (const bot of (data.results || [])) {
        try {
          await fetch(`${BASE_URL}/api/v1/bot/${bot.id}/leave_call/`, {
            method: "POST", headers: { Authorization: `Token ${API_KEY}` },
          });
          total++;
        } catch {}
      }
    } catch {}
  }
  bots.clear();
  return total;
}

// ── Cleanup on shutdown ─────────────────────────────────────────────

async function cleanup() {
  console.log("[server] Shutting down — removing all bots...");
  const removed = await forceRemoveAllBots();
  console.log(`[server] Removed ${removed} bots on shutdown`);
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// ── Start server ────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`[server] Backend running on http://localhost:${PORT}`);

  // Don't auto-cleanup on startup (too slow, kills newly deployed bots)

  // Start RTMP server
  nms.run();
  console.log(`[rtmp] RTMP ingest on rtmp://localhost:1935`);
  console.log(`[rtmp] HLS playback on http://localhost:8000/live/{stream}/index.m3u8`);

  // Auto-start cloudflared for output media (no interstitial)
  if (!process.env.CLOUDFLARED_URL) {
    console.log(`[server] Starting cloudflared tunnel...`);
    startCloudflared().then((url) => {
      if (url) {
        console.log(`[server] Output Media (30fps): ${url}/output-media`);
      } else {
        console.log(`[server] cloudflared failed — bot camera disabled`);
      }
    });
  } else {
    console.log(`[server] Output Media (30fps): ${tunnelHttpUrl}/output-media`);
  }

  // Detect ngrok for RTMP
  detectTunnels().then(() => {
    if (ngrokTcpUrl) {
      console.log(`[server] RTMP via ngrok: ${ngrokTcpUrl.replace("tcp://", "rtmp://")}/live/{bot-id}`);
    }
  });
});
