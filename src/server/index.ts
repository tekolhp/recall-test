import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());

const API_KEY = process.env.RECALL_API_KEY!;
const REGION = process.env.RECALL_REGION || "us-west-2";
const BASE_URL = `https://${REGION}.recall.ai`;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!API_KEY) {
  console.error("Missing RECALL_API_KEY in .env");
  process.exit(1);
}

/**
 * POST /api/create-upload
 *
 * Creates a Desktop SDK upload on Recall.ai and returns the upload token.
 * The Electron app calls this before starting a recording.
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
 * Handles sdk_upload.complete / sdk_upload.failed webhooks from Recall.ai.
 * After completion, you can download the recording and transcript.
 */
app.post("/webhooks/recall", async (req, res) => {
  const { event, data } = req.body;
  console.log(`[webhook] Received: ${event}`);

  if (event === "sdk_upload.complete") {
    const recordingId = data?.recording?.id;
    console.log(`[webhook] Upload complete! Recording ID: ${recordingId}`);

    // Fetch the recording details to get download URLs
    if (recordingId) {
      try {
        const response = await fetch(
          `${BASE_URL}/api/v1/recording/${recordingId}/`,
          {
            headers: { Authorization: `Token ${API_KEY}` },
          }
        );
        const recording = await response.json();
        console.log("[webhook] Recording details:", JSON.stringify(recording, null, 2));
      } catch (err) {
        console.error("[webhook] Error fetching recording:", err);
      }
    }
  }

  if (event === "sdk_upload.failed") {
    console.error("[webhook] Upload failed:", data);
  }

  res.json({ ok: true });
});

/**
 * GET /api/recording/:id
 *
 * Proxies a recording fetch from Recall.ai (so the Electron app can retrieve results).
 */
app.get("/api/recording/:id", async (req, res) => {
  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/recording/${req.params.id}/`,
      {
        headers: { Authorization: `Token ${API_KEY}` },
      }
    );

    if (!response.ok) {
      res.status(response.status).json({ error: "Not found" });
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("[server] Error fetching recording:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Backend running on http://localhost:${PORT}`);
  console.log(`[server] Webhook URL: http://localhost:${PORT}/webhooks/recall`);
});
