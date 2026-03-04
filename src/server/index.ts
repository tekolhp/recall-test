import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { execFile, spawn as nodeSpawn, ChildProcess } from "node:child_process";
import { writeFile, unlink, readFile, copyFile } from "node:fs/promises";
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

// ── App settings (synced from main process) ──────────────────────────

let appSettings = {
  transcriptionProvider: "recallai" as "recallai" | "deepgram",
};

// Recover active bots from Recall API on startup
async function recoverBots() {
  const activeStatuses = [
    "joining_call",
    "in_waiting_room",
    "in_call_not_recording",
    "in_call_recording",
    "recording_permission_allowed",
    "in_breakout_room",
  ];

  let recovered = 0;
  const seenRecallIds = new Set<string>();

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
        // Skip duplicates (same bot could appear across status queries)
        if (seenRecallIds.has(bot.id)) continue;
        seenRecallIds.add(bot.id);

        // Skip if already tracked locally
        const alreadyTracked = Array.from(bots.values()).some(
          (b) => b.recallBotId === bot.id
        );
        if (alreadyTracked) continue;

        // Check actual latest status — skip terminal bots
        const latestStatus =
          bot.status_changes?.[bot.status_changes.length - 1]?.code || status;
        const normalizedStatus = latestStatus.replace("bot.", "");
        const terminalStatuses = ["done", "fatal", "media_expired", "analysis_done", "call_ended"];
        if (terminalStatuses.includes(normalizedStatus)) continue;

        const localId = `recovered-${++botCounter}`;
        bots.set(localId, {
          id: localId,
          recallBotId: bot.id,
          name: bot.bot_name || "Recovered Bot",
          status: normalizedStatus,
          breakoutRoom: null,
          meetingUrl: bot.meeting_url || "",
          createdAt: bot.created_at || new Date().toISOString(),
        });
        recovered++;
        console.log(`[bot] Recovered: ${bot.bot_name} (${bot.id}) status=${latestStatus}`);
      }
    } catch {}
  }

  if (recovered > 0) {
    console.log(`[server] Recovered ${recovered} active bot(s) from Recall API`);
  }
}

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

// Helper: set output_media on a bot (DELETE old first, then POST new)
async function setOutputMedia(bot: BotRecord, pageUrl: string): Promise<boolean> {
  const endpoint = `${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_media/`;
  const headers: Record<string, string> = {
    Authorization: `Token ${API_KEY}`,
    "Content-Type": "application/json",
  };
  // Always DELETE first to clear any existing output_media
  try {
    await fetch(endpoint, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ camera: true }),
    });
  } catch {}
  // Now POST the new one
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ camera: { kind: "webpage", config: { url: pageUrl } } }),
  });
  return response.ok;
}

// Activate output_media on all active bots (uses tunnel URL)
app.post("/api/bots/activate-output-media", async (_req, res) => {
  if (!tunnelHttpUrl) {
    res.status(503).json({ error: "No tunnel available" });
    return;
  }
  let activated = 0;
  for (const [, bot] of bots) {
    if (["done", "fatal", "leaving"].includes(bot.status)) continue;
    try {
      const url = `${tunnelHttpUrl}/output-media?bot=${bot.id}`;
      if (await setOutputMedia(bot, url)) {
        activated++;
        console.log(`[bot] ${bot.id} output_media activated: ${url}`);
      }
    } catch {}
  }
  res.json({ ok: true, activated });
});

// Activate video file output on all active bots
app.post("/api/bots/activate-video-output", async (_req, res) => {
  if (!tunnelHttpUrl) {
    res.status(503).json({ error: "No tunnel available" });
    return;
  }
  if (!currentVideoFile) {
    res.status(400).json({ error: "No video uploaded" });
    return;
  }

  let activated = 0;
  for (const [, bot] of bots) {
    if (["done", "fatal", "leaving"].includes(bot.status)) continue;
    try {
      const url = `${tunnelHttpUrl}/output-media/video`;
      if (await setOutputMedia(bot, url)) {
        activated++;
        console.log(`[bot] ${bot.id} video output activated: ${url}`);
      }
    } catch {}
  }
  res.json({ ok: true, activated });
});

// Activate music output on all active bots
app.post("/api/bots/activate-music-output", async (_req, res) => {
  if (!tunnelHttpUrl) {
    res.status(503).json({ error: "No tunnel available" });
    return;
  }
  if (!currentMusicFile) {
    res.status(400).json({ error: "No music uploaded" });
    return;
  }

  let activated = 0;
  for (const [, bot] of bots) {
    if (["done", "fatal", "leaving"].includes(bot.status)) continue;
    try {
      const url = `${tunnelHttpUrl}/output-media/music`;
      if (await setOutputMedia(bot, url)) {
        activated++;
        console.log(`[bot] ${bot.id} music output activated: ${url}`);
      }
    } catch {}
  }
  res.json({ ok: true, activated });
});

app.post("/api/bots/activate-youtube", express.json(), async (req, res) => {
  if (!tunnelHttpUrl) {
    res.status(503).json({ error: "No tunnel available" });
    return;
  }
  const { videoId } = req.body;
  if (!videoId) {
    res.status(400).json({ error: "Missing videoId" });
    return;
  }

  let activated = 0;
  for (const [, bot] of bots) {
    if (["done", "fatal", "leaving"].includes(bot.status)) continue;
    try {
      const url = `${tunnelHttpUrl}/output-media/youtube?v=${videoId}`;
      if (await setOutputMedia(bot, url)) {
        activated++;
        console.log(`[bot] ${bot.id} YouTube output activated: ${url}`);
      }
    } catch {}
  }
  res.json({ ok: true, activated });
});

// Deactivate output_media on all active bots
app.post("/api/bots/deactivate-output-media", async (_req, res) => {
  let deactivated = 0;
  for (const [, bot] of bots) {
    if (["done", "fatal", "leaving"].includes(bot.status)) continue;
    try {
      const response = await fetch(
        `${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_media/`,
        {
          method: "DELETE",
          headers: { Authorization: `Token ${API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ camera: true }),
        }
      );
      if (response.ok) deactivated++;
    } catch {}
  }
  res.json({ ok: true, deactivated });
});

// ── WebSocket server for Output Media pages ─────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wssPush = new WebSocketServer({ noServer: true });

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

// ── WebSocket for gapless audio streaming (mic → ffmpeg → MP3 → Recall API) ──
const wssAudio = new WebSocketServer({ noServer: true });

wssAudio.on("connection", (ws) => {
  console.log("[ws-audio] Audio push client connected");

  let ffmpeg: ChildProcess | null = null;
  let mp3Buffer: Buffer[] = [];
  let flushInterval: ReturnType<typeof setInterval> | null = null;

  // Spawn persistent ffmpeg: webm stdin → mp3 stdout
  ffmpeg = nodeSpawn("ffmpeg", [
    "-f", "webm", "-i", "pipe:0",
    "-codec:a", "libmp3lame", "-b:a", "128k",
    "-f", "mp3", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  ffmpeg.stderr?.on("data", (d: Buffer) => {
    // Suppress ffmpeg logs (too noisy), only log errors
    const msg = d.toString();
    if (msg.includes("Error") || msg.includes("error")) {
      console.error(`[ws-audio:ffmpeg] ${msg.trim()}`);
    }
  });

  ffmpeg.stdout?.on("data", (chunk: Buffer) => {
    mp3Buffer.push(chunk);
  });

  ffmpeg.on("exit", (code) => {
    console.log(`[ws-audio] ffmpeg exited with code ${code}`);
    ffmpeg = null;
  });

  // Every 3 seconds, flush accumulated MP3 bytes to all active bots
  flushInterval = setInterval(async () => {
    if (mp3Buffer.length === 0) return;

    const mp3Data = Buffer.concat(mp3Buffer);
    mp3Buffer = [];

    if (mp3Data.length < 100) return; // too small, skip

    const mp3B64 = mp3Data.toString("base64");
    const activeBotList = Array.from(bots.values()).filter(
      (b) => !["done", "fatal", "leaving"].includes(b.status)
    );

    if (activeBotList.length === 0) return;

    const body = JSON.stringify({ data: { kind: "mp3", b64_data: mp3B64 } });
    await Promise.allSettled(
      activeBotList.map((bot) =>
        fetch(`${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_audio/`, {
          method: "POST",
          headers: {
            Authorization: `Token ${API_KEY}`,
            "Content-Type": "application/json",
          },
          body,
        })
      )
    );
  }, 3000);

  ws.on("message", (data: Buffer) => {
    // Write raw webm chunk to ffmpeg stdin
    if (ffmpeg && ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
      ffmpeg.stdin.write(data);
    }
  });

  ws.on("close", () => {
    console.log("[ws-audio] Audio push client disconnected");
    if (flushInterval) { clearInterval(flushInterval); flushInterval = null; }
    if (ffmpeg) {
      ffmpeg.stdin?.end();
      ffmpeg.kill("SIGTERM");
      ffmpeg = null;
    }
    mp3Buffer = [];
  });
});

// ── WebSocket for real-time transcript push to renderer ──────────────
const wssTranscript = new WebSocketServer({ noServer: true });
const transcriptClients = new Set<WebSocket>();

wssTranscript.on("connection", (ws) => {
  console.log("[ws-transcript] Client connected");
  transcriptClients.add(ws);
  ws.on("close", () => {
    transcriptClients.delete(ws);
    console.log("[ws-transcript] Client disconnected");
  });
});

function pushTranscriptToClients(data: any) {
  const msg = JSON.stringify(data);
  for (const client of transcriptClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ── WebSocket: real-time transcription FROM Recall.ai (bot connects here) ──
const wssRecallTranscript = new WebSocketServer({ noServer: true });

wssRecallTranscript.on("connection", (ws, req) => {
  console.log("[recall-ws] Recall bot connected for transcript streaming");

  ws.on("message", (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      const eventType = event.event; // "transcript.data" or "transcript.partial_data"
      // Payload is nested: event.data.data.words, event.data.bot.id
      const outer = event.data || {};
      const inner = outer.data || {};
      console.log(`[recall-ws] ${eventType || "unknown"} — ${JSON.stringify(event).slice(0, 300)}`);

      // Find local bot ID by matching recallBotId
      const recallBotId = outer.bot?.id || event.bot_id;
      let localBotId: string | null = null;
      for (const [id, bot] of bots) {
        if (bot.recallBotId === recallBotId) {
          localBotId = id;
          break;
        }
      }

      const words = inner.words || outer.words || [];
      const text = words.map((w: any) => w.text).join(" ") || inner.text || outer.text || "";
      const isFinal = eventType === "transcript.data";

      if (text.trim()) {
        pushTranscriptToClients({
          botId: localBotId || recallBotId,
          speaker: "",
          text,
          is_final: isFinal,
        });
      }
    } catch (err) {
      console.error("[recall-ws] Parse error:", err);
    }
  });

  ws.on("close", () => console.log("[recall-ws] Recall bot disconnected"));
  ws.on("error", (err) => console.error("[recall-ws] Error:", err));
});

// ── Webhook fallback: real-time transcription from Recall.ai ─────────
app.post("/webhook/transcription", express.json(), (req, res) => {
  const event = req.body;
  const eventType = event.event; // "transcript.data" or "transcript.partial_data"
  // Payload is nested: event.data.data.words, event.data.bot.id
  const outer = event.data || {};
  const inner = outer.data || {};
  console.log(`[transcript-webhook] ${eventType || "unknown"} — ${JSON.stringify(event).slice(0, 300)}`);

  // Find local bot ID by matching recallBotId
  const recallBotId = outer.bot?.id || event.bot_id;
  let localBotId: string | null = null;
  for (const [id, bot] of bots) {
    if (bot.recallBotId === recallBotId) {
      localBotId = id;
      break;
    }
  }

  const words = inner.words || outer.words || [];
  const text = words.map((w: any) => w.text).join(" ") || inner.text || outer.text || "";
  const isFinal = eventType === "transcript.data";

  if (text.trim()) {
    pushTranscriptToClients({
      botId: localBotId || recallBotId,
      speaker: "",
      text,
      is_final: isFinal,
    });
  }

  res.sendStatus(200);
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

// ── Video file upload & playback ─────────────────────────────────────

const VIDEO_DIR = path.join(process.cwd(), "media", "video");
if (!existsSync(VIDEO_DIR)) mkdirSync(VIDEO_DIR, { recursive: true });

let currentVideoFile: string | null = null;

app.use("/media/video", express.static(VIDEO_DIR, {
  setHeaders: (res) => {
    res.set("Cache-Control", "no-cache");
    res.set("Access-Control-Allow-Origin", "*");
  },
}));

app.post("/api/upload-video", express.raw({ type: "*/*", limit: "500mb" }), async (req, res) => {
  const fileName = (req.headers["x-filename"] as string) || "video.mp4";
  if (!req.body || req.body.length === 0) {
    res.status(400).json({ error: "No file data" });
    return;
  }

  const ext = path.extname(fileName) || ".mp4";
  const destName = `current${ext}`;
  const destPath = path.join(VIDEO_DIR, destName);

  try {
    // Remove old file if extension changed
    if (currentVideoFile && currentVideoFile !== destName) {
      await unlink(path.join(VIDEO_DIR, currentVideoFile)).catch(() => {});
    }
    await writeFile(destPath, req.body);
    currentVideoFile = destName;
    console.log(`[video] Uploaded: ${fileName} (${req.body.length} bytes) → ${destName}`);
    res.json({ ok: true, filename: destName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Music/audio file upload & playback ────────────────────────────────

const MUSIC_DIR = path.join(process.cwd(), "media", "music");
if (!existsSync(MUSIC_DIR)) mkdirSync(MUSIC_DIR, { recursive: true });

let currentMusicFile: string | null = null;

app.use("/media/music", express.static(MUSIC_DIR, {
  setHeaders: (res) => {
    res.set("Cache-Control", "no-cache");
    res.set("Access-Control-Allow-Origin", "*");
  },
}));

app.post("/api/upload-music", express.raw({ type: "*/*", limit: "500mb" }), async (req, res) => {
  const fileName = (req.headers["x-filename"] as string) || "audio.mp3";
  if (!req.body || req.body.length === 0) {
    res.status(400).json({ error: "No file data" });
    return;
  }

  const ext = path.extname(fileName) || ".mp3";
  const destName = `current${ext}`;
  const destPath = path.join(MUSIC_DIR, destName);

  try {
    if (currentMusicFile && currentMusicFile !== destName) {
      await unlink(path.join(MUSIC_DIR, currentMusicFile)).catch(() => {});
    }
    await writeFile(destPath, req.body);
    currentMusicFile = destName;
    console.log(`[music] Uploaded: ${fileName} (${req.body.length} bytes) → ${destName}`);
    res.json({ ok: true, filename: destName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/output-media/music", (_req, res) => {
  if (!currentMusicFile) {
    res.status(404).send("No music uploaded");
    return;
  }
  res.type("html").send(`<!DOCTYPE html><html><head>
<style>*{margin:0;padding:0}body{background:#000;overflow:hidden;width:100vw;height:100vh}</style>
</head><body>
<audio id="a" autoplay loop src="/media/music/${currentMusicFile}?t=${Date.now()}"></audio>
<script>document.getElementById("a").play().catch(()=>{});</script>
</body></html>`);
});

app.get("/output-media/youtube", (req, res) => {
  const videoId = req.query.v as string;
  if (!videoId) {
    res.status(400).send("Missing ?v= parameter");
    return;
  }
  res.type("html").send(`<!DOCTYPE html><html><head>
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>*{margin:0;padding:0}body{background:#000;overflow:hidden;width:100vw;height:100vh}
iframe{width:100%;height:100%;border:none}</style>
</head><body>
<iframe src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=0&controls=0&loop=1&playlist=${videoId}"
  allow="autoplay; encrypted-media" allowfullscreen></iframe>
</body></html>`);
});

app.get("/output-media/video", (_req, res) => {
  if (!currentVideoFile) {
    res.status(404).send("No video uploaded");
    return;
  }
  res.type("html").send(`<!DOCTYPE html><html><head>
<style>*{margin:0;padding:0}body{background:#000;overflow:hidden;width:100vw;height:100vh}
video{width:100%;height:100%;object-fit:contain}</style>
</head><body>
<video id="v" autoplay loop playsinline src="/media/video/${currentVideoFile}?t=${Date.now()}"></video>
<script>document.getElementById("v").play().catch(()=>{});</script>
</body></html>`);
});

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
  // Clear cached frames so new connections don't get stale data
  latestFrameB64 = null;
  latestFrameVersion = 0;
  lastFrame = null;
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

// ── App Settings Endpoints ───────────────────────────────────────────

app.get("/api/settings", (_req, res) => {
  res.json(appSettings);
});

app.post("/api/settings", (req, res) => {
  const { transcriptionProvider } = req.body;
  if (transcriptionProvider) appSettings.transcriptionProvider = transcriptionProvider;
  console.log(`[settings] Provider: ${appSettings.transcriptionProvider}`);
  res.json(appSettings);
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

    // Build transcription provider config based on app settings
    const transcriptProvider =
      appSettings.transcriptionProvider === "deepgram"
        ? { deepgram_streaming: { language: "multi" } }
        : { recallai_streaming: { language_code: "en", mode: "prioritize_low_latency" } };

    const botPayload: any = {
      meeting_url,
      bot_name: `${bot_name_prefix} ${i}`,
      recording_config: {
        transcript: {
          provider: transcriptProvider,
        },
        realtime_endpoints: [],
      },
      zoom: {
        breakout_room_handling: "auto_accept_all_invites",
      },
    };

    // Real-time transcription via WebSocket (persistent connection, lowest latency)
    if (tunnelHttpUrl) {
      const tunnelWsUrl = tunnelHttpUrl.replace("https://", "wss://").replace("http://", "ws://");
      botPayload.recording_config.realtime_endpoints.push({
        type: "websocket",
        url: `${tunnelWsUrl}/ws/recall-transcript`,
        events: ["transcript.data", "transcript.partial_data"],
      });
    }

    // RTMP streaming: receive live 720p/30fps video from the meeting
    if (ngrokTcpUrl) {
      const rtmpUrl = ngrokTcpUrl.replace("tcp://", "rtmp://") + `/live/${localId}`;
      botPayload.recording_config.video_mixed_flv = {};
      botPayload.recording_config.realtime_endpoints.push({
        type: "rtmp",
        url: rtmpUrl,
        events: ["video_mixed_flv.data"],
      });
      console.log(`[bot] ${localId} RTMP stream → ${rtmpUrl}`);
    }

    // Output media NOT set at creation — activated on demand when user starts feeding
    // Use start-output-media endpoint or the tunnel URL when camera/image is toggled on
    if (tunnelHttpUrl) {
      console.log(`[bot] ${localId} ready — output_media available via ${tunnelHttpUrl}`);
    }
    botPayload.automatic_video_output = {
      in_call_recording: {
        kind: "jpeg" as const,
        b64_data: SILENT_JPEG,
      },
      in_call_not_recording: {
        kind: "jpeg" as const,
        b64_data: SILENT_JPEG,
      },
    };
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

// ── Start output media (URL as bot camera) ───────────────────────────
app.post("/api/bots/:id/start-output-media", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) { res.status(404).json({ error: "Bot not found" }); return; }

  const { url } = req.body;
  if (!url) { res.status(400).json({ error: "url required" }); return; }

  try {
    if (await setOutputMedia(bot, url)) {
      console.log(`[bot] ${bot.id} output_media started: ${url}`);
      res.json({ ok: true });
    } else {
      res.status(502).json({ error: "Failed to set output_media" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stop output media ────────────────────────────────────────────────
app.post("/api/bots/:id/stop-output-media", async (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) { res.status(404).json({ error: "Bot not found" }); return; }

  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_media/`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Token ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ camera: true }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      res.status(502).json({ error: text });
      return;
    }

    console.log(`[bot] ${bot.id} output_media stopped`);
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
      results.push({ id: bot.id, ok: true });
    } catch (err: any) {
      results.push({ id: bot.id, ok: false, error: err.message });
    }
  }

  // Clear local state so new deploys start fresh
  bots.clear();
  botCounter = 0;

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

  // Push JPEG directly via output_video API to each active bot
  let sent = 0;
  let errors = 0;
  const promises: Promise<void>[] = [];
  for (const [, bot] of bots) {
    if (["done", "fatal", "leaving"].includes(bot.status)) continue;
    promises.push(
      fetch(`${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_video/`, {
        method: "POST",
        headers: {
          Authorization: `Token ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind: "jpeg", b64_data }),
      })
        .then(async (r) => {
          if (r.ok) { sent++; console.log(`[bot] output_video OK for ${bot.id}`); }
          else { errors++; const t = await r.text(); console.error(`[bot] output_video FAILED for ${bot.id}: ${r.status} ${t}`); }
        })
        .catch((e) => { errors++; console.error(`[bot] output_video ERROR for ${bot.id}: ${e.message}`); })
    );
  }
  await Promise.all(promises);

  res.json({ ok: true, sent, errors, mode: "api" });
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
    // Use the new transcript API (the old /bot/{id}/transcript/ is deprecated)
    const response = await fetch(
      `${BASE_URL}/api/v1/transcript/?bot_id=${bot.recallBotId}`,
      { headers: { Authorization: `Token ${API_KEY}` } }
    );

    if (!response.ok) {
      res.status(response.status).json({ error: "Transcript not available yet" });
      return;
    }

    const data = await response.json();
    const transcripts = data.results || [];
    const allSegments: any[] = [];

    // Only fetch transcripts created AFTER this bot was deployed
    const botCreatedAt = new Date(bot.createdAt).getTime();
    const currentSession = transcripts.filter((t: any) =>
      new Date(t.created_at || 0).getTime() >= botCreatedAt - 5000
    );

    for (const t of currentSession) {
      if (t.data?.download_url) {
        try {
          const dlRes = await fetch(t.data.download_url);
          if (dlRes.ok) {
            const segments = await dlRes.json();
            if (Array.isArray(segments)) {
              allSegments.push(...segments);
            }
          }
        } catch {}
      }
    }

    res.json(allSegments);
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

// ── WebSocket upgrade routing (noServer mode) ───────────────────────
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url!, `http://localhost`).pathname;

  if (pathname === "/ws/output-media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (pathname === "/ws/frame-push") {
    wssPush.handleUpgrade(req, socket, head, (ws) => wssPush.emit("connection", ws, req));
  } else if (pathname === "/ws/audio-push") {
    wssAudio.handleUpgrade(req, socket, head, (ws) => wssAudio.emit("connection", ws, req));
  } else if (pathname === "/ws/transcript") {
    wssTranscript.handleUpgrade(req, socket, head, (ws) => wssTranscript.emit("connection", ws, req));
  } else if (pathname === "/ws/recall-transcript") {
    wssRecallTranscript.handleUpgrade(req, socket, head, (ws) => wssRecallTranscript.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ── Start server ────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`[server] Backend running on http://localhost:${PORT}`);

  // Recover any active bots from Recall API (e.g. after accidental crash)
  recoverBots().catch((err) =>
    console.error("[server] Bot recovery failed:", err)
  );

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

// ── Graceful shutdown: remove all bots on SIGTERM/SIGINT ─────────────
async function cleanupBots() {
  if (bots.size === 0) return;
  console.log(`[server] Cleaning up ${bots.size} bot(s) before exit...`);
  const promises: Promise<void>[] = [];
  for (const [, bot] of bots) {
    if (["done", "fatal"].includes(bot.status)) continue;
    promises.push(
      fetch(`${BASE_URL}/api/v1/bot/${bot.recallBotId}/leave_call/`, {
        method: "POST",
        headers: { Authorization: `Token ${API_KEY}` },
      })
        .then(() => console.log(`[server] Removed ${bot.name} (${bot.id})`))
        .catch(() => {})
    );
  }
  await Promise.all(promises);
  console.log("[server] All bots cleaned up");
}

process.on("SIGTERM", async () => {
  await cleanupBots();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await cleanupBots();
  process.exit(0);
});
