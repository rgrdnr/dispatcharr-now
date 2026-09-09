/**
 * Thin client for a Dispatcharr instance.
 *
 * Dispatcharr's live-stats surface has moved around between releases
 * (/proxy/ts/status in older builds, a combined stats endpoint in newer ones),
 * so this probes a list of candidates on first use and remembers what worked.
 * Shapes are normalized aggressively — see normalizeStatus().
 *
 * The status payload identifies a stream by `stream_id`, not by the channel's
 * own id — the join to /api/channels/channels/ is through each channel's
 * `streams` array, not a shared "channel id". See channels() below.
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
const PROGRAM_SEARCH_PATH = '/api/epg/programs/search/';
const USERS_PATH = '/api/accounts/users/';
const STREAM_PROFILES_PATH = '/api/core/streamprofiles/';
const SYSTEM_EVENTS_PATH = '/api/core/system-events/';
const logoPath = (id) => `/api/channels/logos/${id}/`;

const FIVE_MIN = 5 * 60 * 1000;
const ONE_MIN = 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

export class Dispatcharr {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.username = username;
    this.password = password;

    this.access = null;
    this.refresh = null;
    this.accessExpiry = 0;

    this.statusPath = null; // learned on first successful probe
    this.channelPath = null;
    this.programsSupported = true;

    this.channelCache = { at: 0, byId: new Map(), byStreamId: new Map() };
    this.userCache = { at: 0, byId: new Map() };
    this.profileCache = { at: 0, byId: new Map() };
    this.programCache = { at: 0, byUuid: new Map() };
    this.logoCache = new Map(); // logoId -> { at, url, cacheUrl }
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

  /**
   * Channel metadata, cached for 5 minutes. Returns both a byId map (channel's
   * own numeric id — used for the logo route) and a byStreamId map (each of a
   * channel's `streams[]` entries — this is the actual join key against a
   * status entry's `stream_id`).
   */
  async channels() {
    if (Date.now() - this.channelCache.at < FIVE_MIN && this.channelCache.byId.size) {
      return this.channelCache;
    }
    const paths = this.channelPath ? [this.channelPath] : CANDIDATE_CHANNEL_PATHS;
    for (const path of paths) {
      try {
        const data = await this.call(path);
        const list = Array.isArray(data) ? data : data.results || data.channels || [];
        if (!Array.isArray(list)) continue;
        const byId = new Map();
        const byStreamId = new Map();
        for (const c of list) {
          if (!c || c.id == null) continue;
          byId.set(String(c.id), c);
          for (const sid of Array.isArray(c.streams) ? c.streams : []) {
            byStreamId.set(String(sid), c);
          }
        }
        this.channelPath = path;
        this.channelCache = { at: Date.now(), byId, byStreamId };
        return this.channelCache;
      } catch {
        this.channelPath = null;
      }
    }
    return this.channelCache;
  }

  /** Resolve a logo id to its image URL (Dispatcharr's own cache when it has one). */
  async logo(logoId) {
    if (logoId == null) return null;
    const key = String(logoId);
    const cached = this.logoCache.get(key);
    if (cached && Date.now() - cached.at < ONE_DAY) return cached;
    try {
      const data = await this.call(logoPath(logoId));
      const entry = { at: Date.now(), url: data.url || null, cacheUrl: data.cache_url || null };
      this.logoCache.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /** id -> username, cached for 5 minutes. Used to resolve a client's bare user_id. */
  async users() {
    if (Date.now() - this.userCache.at < FIVE_MIN && this.userCache.byId.size) {
      return this.userCache.byId;
    }
    try {
      const data = await this.call(USERS_PATH);
      const list = Array.isArray(data) ? data : data.results || [];
      const byId = new Map();
      for (const u of list) {
        if (u && u.id != null) byId.set(String(u.id), u.username || null);
      }
      this.userCache = { at: Date.now(), byId };
      return byId;
    } catch {
      return this.userCache.byId;
    }
  }

  /** id -> {name, parameters}, cached for 5 minutes. Lets us tell relay from transcode. */
  async streamProfiles() {
    if (Date.now() - this.profileCache.at < FIVE_MIN && this.profileCache.byId.size) {
      return this.profileCache.byId;
    }
    try {
      const data = await this.call(STREAM_PROFILES_PATH);
      const list = Array.isArray(data) ? data : data.results || [];
      const byId = new Map();
      for (const p of list) {
        if (p && p.id != null) byId.set(String(p.id), { name: p.name, parameters: p.parameters || '' });
      }
      this.profileCache = { at: Date.now(), byId };
      return byId;
    } catch {
      return this.profileCache.byId;
    }
  }

  /**
   * Current EPG program per channel, keyed by the channel's `uuid` (that's
   * the join key this endpoint actually returns — not a channel id). Cached
   * for a minute: the payload is the whole guide's current slice (~1MB) and
   * this build ignores any filtering we send it, so there's no cheaper call
   * to make. Degrades to an empty map if the endpoint isn't there at all.
   */
  async currentPrograms() {
    if (!this.programsSupported) return new Map();
    if (Date.now() - this.programCache.at < ONE_MIN && this.programCache.byUuid.size) {
      return this.programCache.byUuid;
    }
    try {
      const data = await this.call(CURRENT_PROGRAMS_PATH, {
        method: 'POST',
        body: { channel_ids: [] },
      });
      const list = Array.isArray(data) ? data : data.results || [];
      const byUuid = new Map();
      for (const entry of list) {
        const uuid = entry && (entry.channel_uuid || entry.channel_id);
        if (uuid != null) byUuid.set(String(uuid), entry);
      }
      this.programCache = { at: Date.now(), byUuid };
      return byUuid;
    } catch {
      this.programsSupported = false;
      return new Map();
    }
  }

  /**
   * The next programme on a channel after `afterIso`, via the filtered
   * search endpoint (unlike currentPrograms() above, this one actually
   * honors its query params) — cheap since it's called per active channel,
   * not the whole guide. `channelId` is our internal numeric channel id.
   */
  async nextProgram(channelId, afterIso) {
    if (channelId == null) return null;
    try {
      const qs = new URLSearchParams({ channel_id: String(channelId), start_after: afterIso, page_size: '1' });
      const data = await this.call(`${PROGRAM_SEARCH_PATH}?${qs}`);
      const list = Array.isArray(data) ? data : data.results || [];
      return list[0] || null;
    } catch {
      return null;
    }
  }

  /** Recent connect/disconnect/error/buffering events, newest first. Not cached — only fetched when the history view is open. */
  async systemEvents({ limit = 50 } = {}) {
    try {
      const data = await this.call(`${SYSTEM_EVENTS_PATH}?limit=${limit}&offset=0`);
      return Array.isArray(data.events) ? data.events : [];
    } catch {
      return [];
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

/** Private-range IPv4 check. Returns null (not false) when we can't tell. */
function isPrivateIp(ip) {
  if (!ip) return null;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Tell relay from transcode by reading a stream profile's ffmpeg args.
 * A profile with no command (Dispatcharr's built-in "Proxy"/"Redirect") is a
 * straight passthrough. Otherwise look for -c:v/-c:a overrides, falling back
 * to a blanket "-c copy" applying to whichever stream has no override —
 * this is what Dispatcharr's own bundled profiles use (verified against a
 * live instance: a profile with `-c copy -c:a aac` relays video, transcodes
 * audio). Profiles built around other tools (streamlink, cvlc) don't use
 * this grammar at all, so both come back 'unknown' rather than a guess.
 */
function classifyProfile(profile) {
  if (!profile) return null;
  const params = profile.parameters || '';
  if (!params.trim()) return { video: 'relay', audio: 'relay', profileName: profile.name || null };
  const blanketCopy = /(^|\s)-c\s+copy(\s|$)/.test(params);
  const videoToken = /-c:v\s+(\S+)/.exec(params)?.[1];
  const audioToken = /-c:a\s+(\S+)/.exec(params)?.[1];
  const video = videoToken ? (videoToken === 'copy' ? 'relay' : 'transcode') : blanketCopy ? 'relay' : 'unknown';
  const audio = audioToken ? (audioToken === 'copy' ? 'relay' : 'transcode') : blanketCopy ? 'relay' : 'unknown';
  return { video, audio, profileName: profile.name || null };
}

/** Shared by the current-programs map and the "what's next" search — same upstream shape either way. */
export function normalizeProgram(program) {
  if (!program) return null;
  return {
    title: pick(program, ['title', 'name', 'program_title'], null),
    description: pick(program, ['description', 'desc', 'plot'], null),
    start: pick(program, ['start_time', 'start', 'starts_at'], null),
    end: pick(program, ['end_time', 'end', 'ends_at'], null),
  };
}

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

function normalizeClients(entry, users) {
  const raw = pick(entry, ['clients', 'client_list', 'connections', 'viewers'], []) || [];
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? Object.entries(raw).map(([key, v]) => ({ _key: key, ...(v || {}) }))
      : [];

  return list.map((c, i) => {
    const ip = pick(c, ['ip_address', 'ip', 'client_ip', 'remote_addr'], null);
    const connectedAt = num(pick(c, ['connected_at'], null));
    const connectedSec =
      connectedAt != null
        ? Math.max(0, Date.now() / 1000 - connectedAt)
        : num(pick(c, ['connected_since', 'connection_duration', 'duration', 'uptime']));
    const userId = pick(c, ['user_id'], null);

    return {
      id: String(pick(c, ['client_id', 'id', '_key'], i)),
      ip,
      local: isPrivateIp(ip),
      user:
        (userId != null && users?.get(String(userId))) ||
        pick(c, ['username', 'user', 'xc_username'], null),
      userAgent: pick(c, ['user_agent', 'agent'], null),
      connectedSec,
    };
  });
}

export function normalizeStatus(
  data,
  { channels = { byId: new Map(), byStreamId: new Map() }, programs = new Map(), users = new Map(), profiles = new Map() } = {}
) {
  const entries = toEntryList(data);

  const streams = entries.map((entry, i) => {
    const streamId = pick(entry, ['stream_id'], null);
    const channel = (streamId != null && channels.byStreamId?.get(String(streamId))) || null;
    const channelId = String(channel?.id ?? pick(entry, ['channel_id', 'channelId', 'id', '_key'], i));
    const channelUuid = channel?.uuid ?? null;
    const program = channelUuid ? programs.get(channelUuid) || null : null;
    const clients = normalizeClients(entry, users);

    const bitrate =
      num(pick(entry, ['avg_bitrate_kbps', 'bitrate_kbps', 'stream_bitrate', 'bitrate', 'current_bitrate'])) ??
      (num(pick(entry, ['bitrate_bps'])) != null ? num(entry.bitrate_bps) / 1000 : null);

    const healthy = typeof entry.healthy === 'boolean' ? entry.healthy : null;
    const profileId = pick(entry, ['stream_profile', 'profile', 'output_profile'], null);
    const relay = classifyProfile(profiles.get(String(profileId)));

    return {
      key: `${channelId}-${i}`,
      channelId,
      channelUuid,
      name:
        pick(channel, ['name', 'channel_name'], null) ||
        pick(entry, ['channel_name', 'name', 'title'], `Channel ${channelId}`),
      number: pick(channel, ['channel_number', 'number'], null),
      logo: channel?.logo_id ?? null,
      streamName: pick(entry, ['stream_name', 'source_name', 'stream'], null),
      profile: pick(entry, ['stream_profile', 'profile', 'output_profile'], null),
      relay,
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
      audioChannels: pick(entry, ['audio_channels'], null),
      encodeSpeed: num(pick(entry, ['ffmpeg_speed'], null)),
      uptimeSec: num(pick(entry, ['uptime', 'duration', 'connected_since', 'started_seconds'])),
      totalBytes: num(pick(entry, ['total_bytes', 'bytes_sent', 'transferred'])),
      healthy,
      buffering: healthy === false ? true : Boolean(pick(entry, ['buffering', 'is_buffering'], false)),
      clients,
      clientCount: clients.length || num(pick(entry, ['client_count', 'clients_count'])) || 0,
      program: normalizeProgram(program),
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

const EVENT_TONE = {
  client_connect: 'ok',
  channel_start: 'ok',
  client_disconnect: 'neutral',
  channel_stop: 'neutral',
  epg_refresh: 'neutral',
  epg_download: 'neutral',
  m3u_download: 'neutral',
  m3u_refresh: 'neutral',
  channel_buffering: 'warn',
  channel_reconnect: 'warn',
  channel_error: 'fault',
};

// Account logins and hourly EPG/M3U refresh ticks aren't stream activity — this
// dashboard is about who's watching what and whether it's struggling, and the
// refresh events fire often enough to bury that signal in a short window.
const EVENT_TYPES_HIDDEN = new Set([
  'login_success',
  'login_failed',
  'logout',
  'epg_refresh',
  'epg_download',
  'm3u_download',
  'm3u_refresh',
]);

/** Dispatcharr's system-events feed, cleaned up for the history view. */
export function normalizeEvents(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && !EVENT_TYPES_HIDDEN.has(e.event_type))
    .map((e) => {
      const d = e.details || {};
      return {
        id: e.id,
        type: e.event_type,
        label: e.event_type_display || e.event_type,
        tone: EVENT_TONE[e.event_type] || 'neutral',
        at: e.timestamp,
        channelUuid: e.channel_id || null,
        channelName: e.channel_name || null,
        user: d.username || null,
        ip: d.client_ip || null,
        userAgent: d.user_agent || null,
        durationSec: num(d.duration ?? d.runtime),
        bytes: num(d.bytes_sent ?? d.total_bytes),
        errorType: d.error_type || null,
        attempts: d.attempts ?? d.attempt ?? null,
        maxAttempts: d.max_attempts ?? null,
        speed: num(d.speed),
        streamName: d.stream_name || null,
      };
    });
}
