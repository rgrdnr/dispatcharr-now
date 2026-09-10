import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dispatcharr, normalizeStatus, normalizeEvents, normalizeProgram } from './dispatcharr.js';
import * as store from './instances.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { DISPATCHARR_URL, DISPATCHARR_USER, DISPATCHARR_PASS, PORT = 8790, POLL_MIN_MS = 2000 } = process.env;

// One-time migration: a fresh install with the old single-instance .env
// still works out of the box — it becomes instance zero. Everything after
// this point is configured through /api/instances (and the Settings page),
// not env vars.
if (!store.exists() && DISPATCHARR_URL && DISPATCHARR_USER && DISPATCHARR_PASS) {
  store.add({ name: 'Primary', url: DISPATCHARR_URL, username: DISPATCHARR_USER, password: DISPATCHARR_PASS });
}

// id -> Dispatcharr client. Rebuilt from disk whenever instances change, but
// an unchanged instance keeps its existing client object so it doesn't lose
// its cached token/channels/etc. on every edit of a *different* instance.
const clients = new Map();

function syncPool() {
  const current = store.list();
  const ids = new Set(current.map((i) => i.id));
  for (const id of clients.keys()) {
    if (!ids.has(id)) clients.delete(id);
  }
  for (const inst of current) {
    const url = String(inst.url).replace(/\/+$/, '');
    const existing = clients.get(inst.id);
    const unchanged = existing && existing.baseUrl === url && existing.username === inst.username && existing.password === inst.password;
    if (!unchanged) {
      clients.set(inst.id, new Dispatcharr({ baseUrl: url, username: inst.username, password: inst.password }));
    }
  }
}

function activeInstances() {
  syncPool();
  return store.list().map((inst) => ({ id: inst.id, name: inst.name, client: clients.get(inst.id) }));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// Small cache so several phones on the couch don't multiply load upstream.
let cache = { at: 0, payload: null };

async function collectOne(id, name, client) {
  try {
    const { path: statusPath, data } = await client.fetchStatus();
    const [channels, users, profiles, programs] = await Promise.all([
      client.channels(),
      client.users(),
      client.streamProfiles(),
      client.currentPrograms(),
    ]);
    const result = normalizeStatus(data, { channels, users, profiles, programs });

    // "What's on next" — cheap per-channel lookups, only for streams actually
    // playing right now, not the whole guide.
    await Promise.all(
      result.streams.map(async (s) => {
        const after = s.program?.end || new Date().toISOString();
        const next = await client.nextProgram(s.channelId, after);
        s.nextProgram = normalizeProgram(next);
      })
    );

    // Dispatcharr's HDHomeRun-emulation stream endpoint needs no auth at
    // all (verified against a live instance) — safe to hand straight to an
    // external player like VLC, unlike everything else in this API.
    for (const s of result.streams) {
      s.watchUrl = s.channelUuid ? `${client.baseUrl}/proxy/ts/stream/${s.channelUuid}?output_profile=1` : null;
    }

    return { id, name, ok: true, source: statusPath, ...result };
  } catch (err) {
    return { id, name, ok: false, error: err.message };
  }
}

async function collect() {
  const results = await Promise.all(activeInstances().map((a) => collectOne(a.id, a.name, a.client)));
  const totals = results.reduce(
    (sum, r) =>
      r.ok
        ? {
            streams: sum.streams + r.totals.streams,
            clients: sum.clients + r.totals.clients,
            bitrateKbps: sum.bitrateKbps + (r.totals.bitrateKbps || 0),
          }
        : sum,
    { streams: 0, clients: 0, bitrateKbps: 0 }
  );
  return {
    updatedAt: new Date().toISOString(),
    instances: results,
    totals: { ...totals, bitrateKbps: totals.bitrateKbps || null },
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

app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const perInstance = Math.min(200, limit + 15);
    const results = await Promise.all(
      activeInstances().map(async (a) => {
        const raw = await a.client.systemEvents({ limit: perInstance });
        return normalizeEvents(raw).map((e) => ({ ...e, instanceId: a.id, instanceName: a.name }));
      })
    );
    const merged = results
      .flat()
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, limit);
    res.json({ events: merged });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Handy while you're confirming shapes against one of your instances.
app.get('/api/debug/raw', async (req, res) => {
  try {
    const active = activeInstances();
    const target = req.query.instance ? active.find((a) => a.id === req.query.instance) : active[0];
    if (!target) return res.status(404).json({ error: 'No instances configured.' });
    const { path: statusPath, data } = await target.client.fetchStatus();
    res.json({ instance: target.name, source: statusPath, data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Logos live behind a numeric logo_id, resolved through /api/channels/logos/<id>/
// (its cache_url is Dispatcharr's own copy and needs our auth; url is the
// original CDN link and doesn't). Proxy either way so the browser never needs
// Dispatcharr credentials. Channel ids are only unique within one instance,
// so the instance has to be part of the route.
app.get('/api/logo/:instanceId/:channelId', async (req, res) => {
  try {
    const client = clients.get(req.params.instanceId);
    if (!client) return res.status(404).end();
    const { byId } = await client.channels();
    const channel = byId.get(String(req.params.channelId));
    if (!channel?.logo_id) return res.status(404).end();
    const logo = await client.logo(channel.logo_id);
    const target = logo?.cacheUrl || logo?.url;
    if (!target) return res.status(404).end();
    const needsAuth = target.startsWith(client.baseUrl);
    const upstream = await fetch(target, needsAuth ? { headers: { Authorization: `Bearer ${await client.token()}` } } : {});
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=14400');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// Full channel catalog for one instance — not used by this app's own UI
// (/api/now already tells us who's live), but lets another client (e.g. a
// dashboard widget) let a user browse/search channels once to build a
// static favorites list. Reuses channels()'s existing 5-minute cache.
app.get('/api/instances/:id/channels', async (req, res) => {
  try {
    syncPool(); // don't depend on /api/now having warmed the pool first
    const client = clients.get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Not found.' });

    const { byId } = await client.channels();
    const q = String(req.query.q || '').trim().toLowerCase();

    const list = Array.from(byId.values())
      .map((c) => ({
        id: String(c.id),
        uuid: c.uuid ?? null,
        name: c.name || c.channel_name || `Channel ${c.id}`,
        number: c.channel_number ?? c.number ?? null,
        logoId: c.logo_id ?? null,
      }))
      .filter((c) => c.uuid) // no uuid means no watchUrl is possible — not favoritable
      .filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.number ?? '').includes(q));

    list.sort((a, b) => {
      const an = Number(a.number);
      const bn = Number(b.number);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return a.name.localeCompare(b.name);
    });

    res.json({ channels: list });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------- instance management ----------

app.get('/api/instances', (req, res) => {
  res.json({ instances: store.list().map(store.toPublic) });
});

app.post('/api/instances', (req, res) => {
  const { name, url, username, password } = req.body || {};
  if (!url || !username || !password) {
    return res.status(400).json({ error: 'url, username and password are required.' });
  }
  const created = store.add({ name, url, username, password });
  res.status(201).json(store.toPublic(created));
});

app.put('/api/instances/:id', (req, res) => {
  const updated = store.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Not found.' });
  res.json(store.toPublic(updated));
});

app.delete('/api/instances/:id', (req, res) => {
  const removed = store.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

async function probe(url, username, password) {
  try {
    await new Dispatcharr({ baseUrl: url, username, password }).login();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Test an unsaved draft (Settings form, before "Add").
app.post('/api/instances/test', async (req, res) => {
  const { url, username, password } = req.body || {};
  res.json(await probe(url, username, password));
});

// Re-test an already-saved instance.
app.post('/api/instances/:id/test', async (req, res) => {
  const inst = store.list().find((x) => x.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found.' });
  res.json(await probe(inst.url, inst.username, inst.password));
});

app.get('/api/health', (req, res) => res.json({ ok: true, instances: store.list().length }));

const webRoot = path.join(__dirname, '../../web/dist');
app.use(express.static(webRoot));
app.get('*', (req, res) => res.sendFile(path.join(webRoot, 'index.html')));

app.listen(PORT, () => {
  console.log(`Watching ${store.list().length} Dispatcharr instance(s) — open http://localhost:${PORT}`);
});
