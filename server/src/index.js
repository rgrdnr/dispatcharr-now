import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dispatcharr, normalizeStatus } from './dispatcharr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  DISPATCHARR_URL = 'http://192.168.0.149:9090',
  DISPATCHARR_USER,
  DISPATCHARR_PASS,
  PORT = 8790,
  POLL_MIN_MS = 2000,
} = process.env;

if (!DISPATCHARR_USER || !DISPATCHARR_PASS) {
  console.error('Set DISPATCHARR_USER and DISPATCHARR_PASS (see .env.example).');
  process.exit(1);
}

const dispatcharr = new Dispatcharr({
  baseUrl: DISPATCHARR_URL,
  username: DISPATCHARR_USER,
  password: DISPATCHARR_PASS,
});

const app = express();
app.disable('x-powered-by');

// Small cache so several phones on the couch don't multiply load upstream.
let cache = { at: 0, payload: null };

async function collect() {
  const { path: statusPath, data } = await dispatcharr.fetchStatus();
  const channels = await dispatcharr.channels();

  const preliminary = normalizeStatus(data, { channels });
  const ids = preliminary.streams.map((s) => s.channelId);
  const programs = await dispatcharr.currentPrograms(ids);

  const result = normalizeStatus(data, { channels, programs });
  return {
    updatedAt: new Date().toISOString(),
    source: statusPath,
    ...result,
  };
}

app.get('/api/now', async (req, res) => {
  try {
    if (cache.payload && Date.now() - cache.at < Number(POLL_MIN_MS)) {
      return res.json(cache.payload);
    }
    const payload = await collect();
    cache = { at: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Handy while you're confirming shapes against your own instance.
app.get('/api/debug/raw', async (req, res) => {
  try {
    const { path: statusPath, data } = await dispatcharr.fetchStatus();
    res.json({ source: statusPath, data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Logos may sit behind auth or on a different origin; proxy them.
app.get('/api/logo/:channelId', async (req, res) => {
  try {
    const channels = await dispatcharr.channels();
    const channel = channels.get(String(req.params.channelId));
    const logo = channel?.logo_url || channel?.logo;
    if (!logo) return res.status(404).end();
    const target = /^https?:\/\//.test(logo) ? logo : dispatcharr.url(logo);
    const upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${await dispatcharr.token()}` },
    });
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=14400');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, upstream: DISPATCHARR_URL }));

const webRoot = path.join(__dirname, '../../web/dist');
app.use(express.static(webRoot));
app.get('*', (req, res) => res.sendFile(path.join(webRoot, 'index.html')));

app.listen(PORT, () => {
  console.log(`Watching ${DISPATCHARR_URL} — open http://localhost:${PORT}`);
});
