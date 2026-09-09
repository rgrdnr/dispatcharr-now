/**
 * Thin client for a Dispatcharr instance.
 *
 * Dispatcharr's live-stats surface has moved around between releases
 * (/proxy/ts/status in older builds, a combined stats endpoint in newer ones),
 * so this probes a list of candidates on first use and remembers what worked.
 * Shapes are normalized aggressively — see normalizeStatus().
 */

const CANDIDATE_STATUS_PATHS = [
  '/proxy/ts/status',
  '/api/channels/stats/',
  '/api/core/stats/',
  '/api/channels/channels/stats/',
];

const CANDIDATE_CHANNEL_PATHS = [
  '/api/channels/channels/',
  '/api/channels/',
];

const CURRENT_PROGRAMS_PATH = '/api/epg/current-programs/';

export class Dispatcharr {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.username = username;
    this.password = password;

    this.access = null;
    this.refresh = null;
    this.accessExpiry = 0;

    this.statusPath = null;      // learned on first successful probe
    this.channelPath = null;
    this.programsSupported = true;

    this.channelCache = { at: 0, byId: new Map() };
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  async login() {
    const res = await fetch(this.url('/api/accounts/token/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Login failed (${res.status}). Check DISPATCHARR_USER / DISPATCHARR_PASS. ${body.slice(0, 200)}`
      );
    }
    const data = await res.json();
    this.access = data.access || data.token;
    this.refresh = data.refresh || null;
    // Dispatcharr's access tokens are short-lived; refresh well before the hour.
    this.accessExpiry = Date.now() + 25 * 60 * 1000;
    if (!this.access) throw new Error('Login succeeded but no access token was returned.');
    return this.access;
  }

  async refreshToken() {
    if (!this.refresh) return this.login();
    const res = await fetch(this.url('/api/accounts/token/refresh/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: this.refresh }),
    });
    if (!res.ok) return this.login();
    const data = await res.json();
    this.access = data.access;
    this.accessExpiry = Date.now() + 25 * 60 * 1000;
    return this.access;
  }

  async token() {
    if (!this.access) return this.login();
    if (Date.now() > this.accessExpiry) return this.refreshToken();
    return this.access;
  }

  /** Authenticated fetch with one automatic retry on 401. */
  async call(path, { method = 'GET', body, raw = false } = {}) {
    const send = async (token) =>
      fetch(this.url(path), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    let res = await send(await this.token());
    if (res.status === 401) {
      this.access = null;
      res = await send(await this.token());
    }
    if (raw) return res;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** Find whichever live-stats endpoint this build exposes. */
  async fetchStatus() {
    const paths = this.statusPath ? [this.statusPath] : CANDIDATE_STATUS_PATHS;
    const tried = [];
    for (const path of paths) {
      try {
        const data = await this.call(path);
        this.statusPath = path;
        return { path, data };
      } catch (err) {
        tried.push(`${path}: ${err.status || err.message}`);
        if (err.status === 403) {
          throw new Error(
            'Dispatcharr returned 403 for live stats. Recent releases restrict connection ' +
              'telemetry to admin accounts — use admin credentials for this app.'
          );
        }
        this.statusPath = null;
      }
    }
    throw new Error(`No live-stats endpoint responded. Tried — ${tried.join(' | ')}`);
  }

  /** Channel metadata (names, logos, numbers), cached for 5 minutes. */
  async channels() {
    if (Date.now() - this.channelCache.at < 5 * 60 * 1000 && this.channelCache.byId.size) {
      return this.channelCache.byId;
    }
    const paths = this.channelPath ? [this.channelPath] : CANDIDATE_CHANNEL_PATHS;
    for (const path of paths) {
      try {
        const data = await this.call(path);
        const list = Array.isArray(data) ? data : data.results || data.channels || [];
        if (!Array.isArray(list)) continue;
        const byId = new Map();
        for (const c of list) {
          if (c && c.id != null) byId.set(String(c.id), c);
        }
        this.channelPath = path;
        this.channelCache = { at: Date.now(), byId };
        return byId;
      } catch {
        this.channelPath = null;
      }
    }
    return new Map();
  }

  /** Current EPG program per channel. Degrades to empty if unsupported. */
  async currentPrograms(channelIds) {
    if (!this.programsSupported || !channelIds.length) return new Map();
    try {
      const data = await this.call(CURRENT_PROGRAMS_PATH, {
        method: 'POST',
        body: { channel_ids: channelIds.map(Number).filter(Number.isFinite) },
      });
      const byId = new Map();
      const entries = Array.isArray(data) ? data : Object.entries(data || {});
      for (const entry of entries) {
        if (Array.isArray(entry)) {
          const [id, value] = entry;
          byId.set(String(id), Array.isArray(value) ? value[0] : value);
        } else if (entry && entry.channel_id != null) {
          byId.set(String(entry.channel_id), entry.program || entry.current_program || entry);
        }
      }
      return byId;
    } catch {
      this.programsSupported = false;
      return new Map();
    }
  }
}

/* ---------- normalization ---------- */

const pick = (obj, keys, fallback = undefined) => {
  if (!obj) return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return fallback;
};

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

/** Status payloads come back as an array, or as a map keyed by channel id. */
function toEntryList(data) {
  if (!data) return [];
  const container =
    (Array.isArray(data) && data) ||
    data.channels ||
    data.active_channels ||
    data.streams ||
    data.results ||
    data.live ||
    data;

  if (Array.isArray(container)) return container.filter((x) => x && typeof x === 'object');
  if (typeof container === 'object') {
    return Object.entries(container)
      .filter(([, v]) => v && typeof v === 'object')
      .map(([key, v]) => ({ _key: key, ...v }));
  }
  return [];
}

function normalizeClients(entry) {
  const raw = pick(entry, ['clients', 'client_list', 'connections', 'viewers'], []) || [];
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? Object.entries(raw).map(([key, v]) => ({ _key: key, ...(v || {}) }))
      : [];

  return list.map((c, i) => ({
    id: String(pick(c, ['client_id', 'id', '_key'], i)),
    ip: pick(c, ['ip_address', 'ip', 'client_ip', 'remote_addr'], null),
    user: pick(c, ['username', 'user', 'xc_username'], null),
    userAgent: pick(c, ['user_agent', 'agent'], null),
    connectedSec: num(pick(c, ['connected_since', 'connection_duration', 'duration', 'uptime'])),
  }));
}

export function normalizeStatus(data, { channels = new Map(), programs = new Map() } = {}) {
  const entries = toEntryList(data);

  const streams = entries.map((entry, i) => {
    const channelId = String(
      pick(entry, ['channel_id', 'channelId', 'id', '_key'], i)
    );
    const channel = channels.get(channelId) || {};
    const program = programs.get(channelId) || null;
    const clients = normalizeClients(entry);

    const bitrate =
      num(pick(entry, ['bitrate_kbps', 'stream_bitrate', 'bitrate', 'current_bitrate'])) ??
      (num(pick(entry, ['bitrate_bps'])) != null ? num(entry.bitrate_bps) / 1000 : null);

    return {
      key: `${channelId}-${i}`,
      channelId,
      name:
        pick(entry, ['channel_name', 'name', 'title'], null) ||
        pick(channel, ['name', 'channel_name'], `Channel ${channelId}`),
      number: pick(channel, ['channel_number', 'number'], null),
      logo:
        pick(channel, ['logo_url', 'logo'], null) ||
        pick(entry, ['logo_url', 'logo'], null),
      streamName: pick(entry, ['stream_name', 'source_name', 'stream'], null),
      profile: pick(entry, ['stream_profile', 'profile', 'output_profile'], null),
      state: String(
        pick(entry, ['state', 'status', 'stream_state'], clients.length ? 'active' : 'idle')
      ).toLowerCase(),
      bitrateKbps: bitrate,
      resolution:
        pick(entry, ['resolution', 'video_resolution'], null) ||
        (entry.width && entry.height ? `${entry.width}x${entry.height}` : null),
      fps: num(pick(entry, ['source_fps', 'fps', 'frame_rate'])),
      videoCodec: pick(entry, ['video_codec', 'codec', 'video_encoder'], null),
      audioCodec: pick(entry, ['audio_codec', 'audio_format'], null),
      uptimeSec: num(pick(entry, ['uptime', 'duration', 'connected_since', 'started_seconds'])),
      totalBytes: num(pick(entry, ['total_bytes', 'bytes_sent', 'transferred'])),
      buffering: Boolean(pick(entry, ['buffering', 'is_buffering'], false)),
      clients,
      clientCount: clients.length || num(pick(entry, ['client_count', 'clients_count'])) || 0,
      program: program
        ? {
            title: pick(program, ['title', 'name', 'program_title'], null),
            description: pick(program, ['description', 'desc', 'plot'], null),
            start: pick(program, ['start_time', 'start', 'starts_at'], null),
            end: pick(program, ['end_time', 'end', 'ends_at'], null),
          }
        : null,
    };
  });

  // Streams with viewers first, then by channel number.
  streams.sort((a, b) => {
    if (b.clientCount !== a.clientCount) return b.clientCount - a.clientCount;
    return String(a.number ?? a.name).localeCompare(String(b.number ?? b.name), undefined, {
      numeric: true,
    });
  });

  return {
    streams,
    totals: {
      streams: streams.length,
      clients: streams.reduce((sum, s) => sum + s.clientCount, 0),
      bitrateKbps: streams.reduce((sum, s) => sum + (s.bitrateKbps || 0), 0) || null,
    },
  };
}
