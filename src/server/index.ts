import "dotenv/config";
import express from "express";
import { execFile } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const app = express();
app.use(express.json({ limit: "5mb" })); // larger limit for base64 images

const API_KEY = process.env.RECALL_API_KEY!;
const REGION = process.env.RECALL_REGION || "us-west-2";
const BASE_URL = `https://${REGION}.recall.ai`;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!API_KEY) {
  console.error("Missing RECALL_API_KEY in .env");
  process.exit(1);
}

// ── Bot fleet state ──────────────────────────────────────────────────

interface BotRecord {
  id: string; // local ID (bot-1, bot-2, ...)
  recallBotId: string; // Recall.ai bot UUID
  name: string;
  status: string;
  breakoutRoom: string | null;
  meetingUrl: string;
  createdAt: string;
}

const bots = new Map<string, BotRecord>();

// 1-pixel silent JPEG for enabling automatic_video_output
const SILENT_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=";

// Minimal silent MP3 (required to enable output_audio endpoint)
const SILENT_MP3 =
  "//uQxAAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

// ── Desktop SDK Endpoints ────────────────────────────────────────────

/**
 * POST /api/create-upload
 *
 * Creates a Desktop SDK upload on Recall.ai and returns the upload token.
 */
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

/**
 * POST /webhooks/recall
 *
 * Handles webhooks from Recall.ai (SDK uploads + bot status changes).
 */
app.post("/webhooks/recall", async (req, res) => {
  const { event, data } = req.body;
  console.log(`[webhook] Received: ${event}`);

  // Desktop SDK webhooks
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

  // Breakout room webhooks
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

/**
 * POST /api/bots/deploy
 *
 * Deploy up to 10 bots to a Zoom meeting. Each bot:
 * - Records audio/video
 * - Captures meeting captions for transcript
 * - Accepts breakout room invites
 * - Has output_video and output_audio enabled via automatic defaults
 */
app.post("/api/bots/deploy", async (req, res) => {
  const {
    meeting_url,
    bot_count = 1,
    bot_name_prefix = "Assistant",
  } = req.body;

  if (!meeting_url) {
    res.status(400).json({ error: "meeting_url is required" });
    return;
  }

  const count = Math.min(Math.max(1, bot_count), 10);
  const created: BotRecord[] = [];
  const errors: { index: number; error: string }[] = [];

  for (let i = 1; i <= count; i++) {
    const localId = `bot-${i}`;

    const botPayload = {
      meeting_url,
      bot_name: `${bot_name_prefix} ${i}`,
      recording_config: {
        transcript: {
          provider: { meeting_captions: {} },
        },
      },
      // Set default images/audio so output_video and output_audio endpoints work
      automatic_video_output: {
        in_call_recording: {
          kind: "jpeg" as const,
          b64_data: SILENT_JPEG,
        },
      },
      automatic_audio_output: {
        in_call_recording: {
          data: {
            kind: "mp3" as const,
            b64_data: SILENT_MP3,
          },
        },
      },
      zoom: {
        breakout_room_handling: "auto_accept_all_invites",
      },
      // Disable automatic bot detection — default config matches "assistant"
      // in bot names and auto-removes them
      automatic_leave: {
        bot_detection: {
          using_participant_events: null,
          using_participant_names: null,
        },
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

  res.json({ created, errors });
});

/**
 * GET /api/bots
 *
 * List all bots, polling Recall.ai for fresh status.
 */
app.get("/api/bots", async (_req, res) => {
  // Refresh statuses from Recall.ai for active bots
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

/**
 * GET /api/bots/:id
 *
 * Get a single bot with fresh Recall.ai data.
 */
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

/**
 * POST /api/bots/:id/leave
 *
 * Remove a bot from the call.
 */
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

/**
 * POST /api/bots/remove-all
 */
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

/**
 * POST /api/bots/force-remove-all
 *
 * Queries Recall.ai for ALL active bots in the workspace and removes them.
 * Works even if the server was restarted and lost local state.
 */
app.post("/api/bots/force-remove-all", async (_req, res) => {
  const removed: string[] = [];
  const errors: { id: string; error: string }[] = [];

  try {
    // Fetch all bots that are not done/fatal
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

    // Also clear local state
    bots.clear();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }

  res.json({ removed, errors, total: removed.length });
});

/**
 * POST /api/bots/:id/send-image
 *
 * Send a JPEG image to a bot's camera feed via Recall.ai output_video API.
 * Body: { b64_data: "base64-encoded JPEG" }
 */
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

  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_video/`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "jpeg",
          b64_data,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`[bot] output_video failed for ${bot.id}: ${text}`);
      res.status(502).json({ error: text });
      return;
    }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bots/broadcast-image
 *
 * Send the same JPEG image to ALL bots' camera feeds.
 * Body: { b64_data: "base64-encoded JPEG" }
 */
app.post("/api/bots/broadcast-image", async (req, res) => {
  const { b64_data } = req.body;
  if (!b64_data) {
    res.status(400).json({ error: "b64_data is required" });
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const bot of bots.values()) {
    if (["done", "fatal", "leaving"].includes(bot.status)) continue;

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

      if (response.ok) sent++;
      else failed++;
    } catch {
      failed++;
    }
  }

  res.json({ ok: true, sent, failed });
});

/**
 * POST /api/bots/:id/send-audio
 *
 * Send an MP3 audio clip to a bot via Recall.ai output_audio API.
 * Body: { b64_data: "base64-encoded MP3" }
 */
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
        body: JSON.stringify({
          data: {
            kind: "mp3",
            b64_data,
          },
        }),
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

/**
 * POST /api/bots/:id/send-audio-webm
 *
 * Accepts a webm audio chunk, transcodes to MP3 via ffmpeg, then sends
 * to Recall.ai output_audio. Used for real-time mic streaming.
 * Body: { b64_data: "base64-encoded webm audio" }
 */
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
    // Write webm to temp file
    await writeFile(webmPath, Buffer.from(b64_data, "base64"));

    // Transcode to MP3
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-i", webmPath, "-codec:a", "libmp3lame", "-b:a", "64k", "-y", mp3Path],
        { timeout: 10000 },
        (err) => (err ? reject(err) : resolve())
      );
    });

    // Read MP3 and send to Recall
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
        body: JSON.stringify({
          data: { kind: "mp3", b64_data: mp3B64 },
        }),
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
    // Cleanup temp files
    unlink(webmPath).catch(() => {});
    unlink(mp3Path).catch(() => {});
  }
});

/**
 * POST /api/bots/broadcast-audio-webm
 *
 * Transcode webm → MP3 once, then send to all active bots.
 * Body: { b64_data: "base64-encoded webm audio" }
 */
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

    let sent = 0;
    let failed = 0;

    for (const bot of bots.values()) {
      if (["done", "fatal", "leaving"].includes(bot.status)) continue;

      try {
        const response = await fetch(
          `${BASE_URL}/api/v1/bot/${bot.recallBotId}/output_audio/`,
          {
            method: "POST",
            headers: {
              Authorization: `Token ${API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { kind: "mp3", b64_data: mp3B64 },
            }),
          }
        );
        if (response.ok) sent++;
        else failed++;
      } catch {
        failed++;
      }
    }

    res.json({ ok: true, sent, failed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    unlink(webmPath).catch(() => {});
    unlink(mp3Path).catch(() => {});
  }
});

/**
 * GET /api/bots/:id/transcript
 *
 * Get transcript for a bot. Fetches from Recall.ai bot data.
 * Transcript is available after the bot finishes (status: done).
 */
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

app.listen(PORT, () => {
  console.log(`[server] Backend running on http://localhost:${PORT}`);
  console.log(`[server] No external tunnels required`);
  console.log(`[server] Bot output_video + output_audio via direct Recall.ai API`);
});
