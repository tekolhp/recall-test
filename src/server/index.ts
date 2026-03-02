import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

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

// 1-pixel silent JPEG for enabling automatic_video_output (API fallback)
const SILENT_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=";

// Minimal silent MP3 (required to enable output_audio endpoint)
const SILENT_MP3 =
  "//uQxAAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

// ── ngrok auto-detection ─────────────────────────────────────────────

let ngrokUrl: string | null = null;

async function detectNgrokUrl(): Promise<string | null> {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    const data = await res.json();
    const httpsTunnel = (data.tunnels as any[])?.find(
      (t: any) => t.proto === "https"
    );
    if (httpsTunnel) {
      ngrokUrl = httpsTunnel.public_url;
      console.log(`[server] Detected ngrok URL: ${ngrokUrl}`);
      return ngrokUrl;
    }
  } catch {
    console.log("[server] ngrok not running — using output_video API fallback");
  }
  return null;
}

app.get("/api/ngrok-status", async (_req, res) => {
  const url = await detectNgrokUrl();
  res.json({ available: !!url, url });
});

// ── WebSocket server for Output Media pages ─────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/output-media" });

// Separate WebSocket for the renderer to push frames directly (no HTTP overhead)
const wssPush = new WebSocketServer({ server, path: "/ws/frame-push" });

wssPush.on("connection", (ws) => {
  console.log("[ws] Frame push client connected (renderer)");

  ws.on("message", (data: Buffer) => {
    // Received binary JPEG frame from renderer — broadcast to all output media pages
    lastFrame = data;
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

const OUTPUT_MEDIA_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; }
  body { width: 1280px; height: 720px; overflow: hidden; background: #000; }
  canvas { display: block; }
</style>
</head><body>
<canvas id="c" width="1280" height="720"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const params = new URLSearchParams(location.search);
const botId = params.get('bot') || 'unknown';

let ws;
let reconnectDelay = 1000;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/output-media?bot=' + botId);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('[output-media] Connected');
    reconnectDelay = 1000;
  };

  ws.onmessage = async (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      const blob = new Blob([evt.data], { type: 'image/jpeg' });
      const bmp = await createImageBitmap(blob);
      ctx.drawImage(bmp, 0, 0, 1280, 720);
      bmp.close();
    } else {
      try {
        const cmd = JSON.parse(evt.data);
        if (cmd.type === 'clear') {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, 1280, 720);
        }
      } catch {}
    }
  };

  ws.onclose = () => {
    console.log('[output-media] Disconnected, reconnecting in ' + reconnectDelay + 'ms');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => ws.close();
}

connect();
</script>
</body></html>`;

app.get("/output-media", (_req, res) => {
  res.type("html").send(OUTPUT_MEDIA_HTML);
});

// ── Output Media frame push endpoint ────────────────────────────────

app.post("/api/output-media/frame", (req, res) => {
  const { b64_data } = req.body;
  if (!b64_data) {
    res.status(400).json({ error: "b64_data is required" });
    return;
  }

  const frame = Buffer.from(b64_data, "base64");
  broadcastToOutputMediaPages(frame);

  res.json({ ok: true, clients: getConnectedClientCount() });
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

  // Re-detect ngrok URL before deploying
  await detectNgrokUrl();

  const count = Math.min(Math.max(1, bot_count), 10);
  const created: BotRecord[] = [];
  const errors: { index: number; error: string }[] = [];

  for (let i = 1; i <= count; i++) {
    const localId = `bot-${i}`;

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

    if (ngrokUrl) {
      // Webpage mode: bot renders our page as its camera at 30fps
      botPayload.output_media = {
        camera: {
          kind: "webpage",
          config: {
            url: `${ngrokUrl}/output-media?bot=${localId}&ngrok-skip-browser-warning=true`,
          },
        },
      };
      // Audio output still via API
      botPayload.automatic_audio_output = {
        in_call_recording: {
          data: { kind: "mp3" as const, b64_data: SILENT_MP3 },
        },
      };
      console.log(`[bot] ${localId} using webpage mode: ${ngrokUrl}/output-media?bot=${localId}`);
    } else {
      // Fallback: output_video API (rate-limited 5fps)
      botPayload.automatic_video_output = {
        in_call_recording: { kind: "jpeg" as const, b64_data: SILENT_JPEG },
      };
      botPayload.automatic_audio_output = {
        in_call_recording: {
          data: { kind: "mp3" as const, b64_data: SILENT_MP3 },
        },
      };
      console.log(`[bot] ${localId} using API fallback mode (no ngrok)`);
    }

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

  res.json({ created, errors, mode: ngrokUrl ? "webpage" : "api" });
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

  // If webpage mode, push via WebSocket
  if (ngrokUrl && getConnectedClientCount() > 0) {
    const frame = Buffer.from(b64_data, "base64");
    broadcastToOutputMediaPages(frame);
    res.json({ ok: true, mode: "webpage" });
    return;
  }

  // Fallback: output_video API
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

  // If webpage mode, push via WebSocket (instant, no rate limit)
  if (ngrokUrl && getConnectedClientCount() > 0) {
    const frame = Buffer.from(b64_data, "base64");
    broadcastToOutputMediaPages(frame);
    res.json({ ok: true, sent: getConnectedClientCount(), failed: 0, mode: "webpage" });
    return;
  }

  // Fallback: output_video API (rate-limited)
  const activeBotList = Array.from(bots.values()).filter(
    (b) => !["done", "fatal", "leaving"].includes(b.status)
  );

  const body = JSON.stringify({ kind: "jpeg", b64_data });
  const results = await Promise.allSettled(
    activeBotList.map((bot) =>
      fetch(`${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_video/`, {
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

  res.json({ ok: true, sent, failed, mode: "api" });
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

// ── Start server ─────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[server] Backend running on http://localhost:${PORT}`);
  detectNgrokUrl().then((url) => {
    if (url) {
      console.log(`[server] Output Media Webpage mode: ${url}/output-media`);
      console.log(`[server] Bots will render page at 30fps — no rate limit`);
    } else {
      console.log(`[server] Fallback mode: output_video API (5fps max)`);
      console.log(`[server] Start ngrok for 30fps: ngrok http 3000`);
    }
  });
});
