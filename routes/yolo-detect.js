// routes/yolo-detect.js
// CommonJS. Proxies /detect-elements to the Python YOLO microservice (Layer 2.5).
// The Python service (yolo-service/) runs as a SEPARATE Railway service; set its
// internal URL in the YOLO_SERVICE_URL env var on this Node service.

const express = require('express');
const router = express.Router();

const PYTHON_SERVICE_URL = process.env.YOLO_SERVICE_URL;

router.post('/detect-elements', async (req, res) => {
  const { screenshot_b64, target_label, step_instruction, screen_region } = req.body || {};

  if (!screenshot_b64) {
    return res.status(400).json({ error: 'screenshot_b64 is required', elements: [] });
  }
  if (!PYTHON_SERVICE_URL) {
    console.error('[YOLO] YOLO_SERVICE_URL env var not set');
    return res.status(503).json({ error: 'YOLO service not configured', elements: [] });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(`${PYTHON_SERVICE_URL}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot_b64, target_label, step_instruction, screen_region }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[YOLO] Python service error ${response.status}: ${text}`);
      return res.status(502).json({ error: 'YOLO service error', elements: [] });
    }

    const data = await response.json();
    console.log(`[YOLO] Detected ${data.elements?.length ?? 0} elements`);
    return res.json(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[YOLO] Timeout calling Python service');
      return res.status(504).json({ error: 'YOLO service timeout', elements: [] });
    }
    console.error('[YOLO] Proxy error:', err.message);
    return res.status(500).json({ error: err.message, elements: [] });
  }
});

module.exports = router;
