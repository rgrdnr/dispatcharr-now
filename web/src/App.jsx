import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const POLL_MS = 5000;
const HISTORY_POLL_MS = 20000;
const ORDER_KEY = 'onnow.instanceOrder';
const COLLAPSED_KEY = 'onnow.collapsedInstances';

const NAV_ITEMS = [
  { id: 'live', label: 'Live' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

const clock = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function mbps(kbps) {
  if (!Number.isFinite(kbps)) return null;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

function gigabytes(bytes) {
  if (!Number.isFinite(bytes)) return null;
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** How far through the current programme we are, 0–100. */
function elapsedPercent(program) {
  if (!program?.start || !program?.end) return 0;
  const start = new Date(program.start).getTime();
  const end = new Date(program.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const pct = ((Date.now() - start) / (end - start)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function timeLeft(end) {
  if (!end) return null;
  const ms = new Date(end).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return duration(ms / 1000);
}

function health(stream) {
  if (stream.state.includes('error') || stream.state.includes('fail')) return 'fault';
  if (stream.buffering || stream.state.includes('connect')) return 'warn';
  return 'ok';
}

/**
 * Best-effort label from a raw User-Agent string — Dispatcharr doesn't hand
 * us a parsed app/OS, just whatever the client sent. Falls back to a
 * trimmed slice of the real string rather than guessing when nothing matches.
 */
function parseAgent(ua) {
  if (!ua) return null;
  const app = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua) && !/Chrome/.test(ua)
          ? 'Safari'
          : /VLC/i.test(ua)
            ? 'VLC'
            : /Kodi/i.test(ua)
              ? 'Kodi'
              : /channels-dvr/i.test(ua)
                ? 'Channels DVR'
                : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'macOS'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (app && os) return `${app} — ${os}`;
  if (app) return app;
  return ua.length > 30 ? `${ua.slice(0, 30)}…` : ua;
}

/** iPadOS reports as "MacIntel" but, unlike a real Mac, has touch support. */
function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * VLC for iOS registers vlc-x-callback:// itself. Desktop VLC doesn't
 * register vlc:// out of the box, but this machine has the
 * stefansundin/vlc-protocol handler installed (a real macOS app + a
 * one-time Automation permission grant), so vlc:// works here too — a
 * plain video/mp2t link would otherwise just download as an extensionless
 * blob in Chrome. On a machine without that handler installed, the vlc://
 * link will silently do nothing; there's no way to detect that from the
 * page, so this app assumes it's present rather than falling back.
 */
function vlcHref(stream) {
  if (isIOS()) {
    return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream.watchUrl)}`;
  }
  return `vlc://${stream.watchUrl}`;
}

function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h}, 42%, 42%)`;
}

/** 'relay' | 'transcode' | 'unknown' -> a chip, or null to hide the line entirely. */
function relayLabel(kind) {
  if (kind === 'relay') return { text: 'Direct Relay', tone: 'ok' };
  if (kind === 'transcode') return { text: 'Transcode', tone: 'warn' };
  return null;
}

function Stream({ stream, instanceId }) {
  const pct = elapsedPercent(stream.program);
  const left = timeLeft(stream.program?.end);
  const bar = health(stream);
  const primary = stream.clients[0] || null;
  const extraClients = stream.clients.slice(1);

  const device = primary ? parseAgent(primary.userAgent) : null;
  const connection = primary?.local === true ? 'Local' : primary?.local === false ? 'Remote' : null;
  const upFor = duration(primary?.connectedSec ?? stream.uptimeSec);

  const video = stream.resolution || stream.videoCodec ? [stream.resolution, stream.videoCodec].filter(Boolean).join(' ') : null;
  const audio = [stream.audioCodec, stream.audioChannels].filter(Boolean).join(' · ') || null;
  const speed = Number.isFinite(stream.encodeSpeed) ? stream.encodeSpeed : null;
  const speedBehind = speed != null && speed < 1;
  const videoRelay = relayLabel(stream.relay?.video);
  const audioRelay = relayLabel(stream.relay?.audio);

  return (
    <li className="card" data-idle={stream.clientCount === 0}>
      <div className="card-head">
        <div className={stream.logo ? 'thumb has-logo' : 'thumb'}>
          {stream.logo ? (
            <img src={`/api/logo/${instanceId}/${stream.channelId}`} alt="" loading="lazy" />
          ) : (
            <span>{stream.number ?? stream.name.slice(0, 2)}</span>
          )}
        </div>
        <div className="title">
          <h2 className="channel">{stream.program?.title || stream.name}</h2>
          <p className="subhead">
            {stream.program?.title ? stream.name : <em>No guide data</em>}
          </p>
        </div>
      </div>

      {stream.program?.start && stream.program?.end && (
        <>
          <div className="elapsed">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="elapsed-times">
            <span>{clock(stream.program.start)}</span>
            <span className="elapsed-remaining">{left ? `${left} left` : 'ending soon'}</span>
            <span>{clock(stream.program.end)}</span>
          </div>
        </>
      )}

      {stream.nextProgram?.title && (
        <p className="next-up">
          <span className="next-label">Next</span>
          <span className="next-title">{stream.nextProgram.title}</span>
          {stream.nextProgram.start && <span className="next-time">{clock(stream.nextProgram.start)}</span>}
        </p>
      )}

      {primary && (
        <div className="device-band" data-health={bar}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="4" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 18v3" />
          </svg>
          <div className="device-info">
            <div className="device-name">{device || 'Unknown device'}</div>
            <div className="device-state">
              {bar === 'fault' ? 'Stream error' : bar === 'warn' ? 'Buffering' : 'Playing'}
              {upFor ? ` — up ${upFor}` : ''}
            </div>
          </div>
          <div className="conn">
            {connection && <div>{connection}</div>}
            {mbps(stream.bitrateKbps) && <div>{mbps(stream.bitrateKbps)}</div>}
          </div>
        </div>
      )}

      {(video || videoRelay) && (
        <div className="info-row">
          <span className="info-label">Video</span>
          <div>
            {video && <div>{video}</div>}
            {videoRelay && (
              <div className={`relay ${videoRelay.tone}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M17 8l4 4-4 4M3 12h18" />
                </svg>
                {videoRelay.text}
              </div>
            )}
            {speed != null && (
              <div className={`relay ${speedBehind ? 'warn' : ''}`}>
                {speedBehind && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 9v4M12 17h.01M10.3 3.86L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
                  </svg>
                )}
                {speed.toFixed(2)}x realtime
              </div>
            )}
          </div>
        </div>
      )}
      {(audio || audioRelay) && (
        <div className="info-row">
          <span className="info-label">Audio</span>
          <div>
            {audio && <div>{audio}</div>}
            {audioRelay && (
              <div className={`relay ${audioRelay.tone}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M17 8l4 4-4 4M3 12h18" />
                </svg>
                {audioRelay.text}
              </div>
            )}
          </div>
        </div>
      )}

      {(primary || stream.watchUrl) && (
        <div className="card-footer">
          {primary && (
            <>
              <span className="avatar" style={{ background: avatarColor(primary.user || primary.ip || primary.id) }}>
                {(primary.user || primary.ip || '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="viewer-id">
                <span className="viewer-name">{primary.user || 'Unknown viewer'}</span>
                {primary.ip && <span className="viewer-ip">{primary.ip}</span>}
              </span>
            </>
          )}
          <span className="footer-actions">
            {extraClients.length > 0 && (
              <span className="more">
                +{extraClients.length} more — {extraClients.map((c) => c.ip || c.user || 'unknown').join(', ')}
              </span>
            )}
            {stream.watchUrl && (
              <a className="vlc-link" href={vlcHref(stream)} aria-label={`Open ${stream.name} in VLC`}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M5 3l15 9-15 9V3z" />
                </svg>
                VLC
              </a>
            )}
          </span>
        </div>
      )}
    </li>
  );
}

function loadOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveOrder(order) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // private browsing / storage disabled — reordering just won't persist
  }
}

/** Apply a saved id order to the live instance list. New instances (not in the saved order) land at the end; removed ones just vanish. */
function applyOrder(instances, order) {
  const byId = new Map(instances.map((i) => [i.id, i]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  const seen = new Set(ordered.map((i) => i.id));
  for (const inst of instances) {
    if (!seen.has(inst.id)) ordered.push(inst);
  }
  return ordered;
}

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(collapsed) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // private browsing / storage disabled — collapse state just won't persist
  }
}

function LiveView({ data, error, staleSince, onRetry }) {
  const totals = data?.totals;
  const rawInstances = data?.instances || [];

  const [order, setOrder] = useState(loadOrder);
  useEffect(() => saveOrder(order), [order]);
  const instances = useMemo(() => applyOrder(rawInstances, order), [rawInstances, order]);
  const groupRefs = useRef(new Map());
  const [draggingId, setDraggingId] = useState(null);
  const instancesRef = useRef(instances);
  instancesRef.current = instances;

  const [collapsed, setCollapsed] = useState(loadCollapsed);
  useEffect(() => saveCollapsed(collapsed), [collapsed]);
  const toggleCollapsed = (id) => (e) => {
    e.stopPropagation();
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const reorder = useCallback(
    (id, toIndex) => {
      setOrder((prevOrder) => {
        const current = applyOrder(rawInstances, prevOrder).map((i) => i.id);
        const fromIndex = current.indexOf(id);
        if (fromIndex === -1 || fromIndex === toIndex) return prevOrder;
        const next = [...current];
        next.splice(fromIndex, 1);
        next.splice(toIndex, 0, id);
        return next;
      });
    },
    [rawInstances]
  );
  const reorderRef = useRef(reorder);
  reorderRef.current = reorder;

  // Tracked on window, not the dragged element: a live reorder physically
  // moves that element's DOM node (React reconciles the new key order), and
  // moving a node mid-gesture can silently drop native pointer capture —
  // the drag would then look "stuck" since pointerup never fires on it.
  useEffect(() => {
    if (!draggingId) return;

    const handleMove = (e) => {
      const y = e.clientY;
      const list = instancesRef.current;
      let toIndex = list.length - 1;
      for (let i = 0; i < list.length; i++) {
        const el = groupRefs.current.get(list[i].id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
          toIndex = i;
          break;
        }
      }
      reorderRef.current(draggingId, toIndex);
    };

    const handleEnd = () => setDraggingId(null);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
    };
  }, [draggingId]);

  const startDrag = (id) => () => setDraggingId(id);

  return (
    <>
      {totals && (
        <div className="tally">
          <span>
            <b>{totals.streams}</b> {totals.streams === 1 ? 'stream' : 'streams'}
          </span>
          <span>
            <b>{totals.clients}</b> {totals.clients === 1 ? 'viewer' : 'viewers'}
          </span>
          {mbps(totals.bitrateKbps) && (
            <span>
              <b>{mbps(totals.bitrateKbps)}</b> total
            </span>
          )}
        </div>
      )}

      {instances.length > 0 && (
        <div className="instances">
          {instances.map((inst) => (
            <section
              key={inst.id}
              ref={(el) => {
                if (el) groupRefs.current.set(inst.id, el);
                else groupRefs.current.delete(inst.id);
              }}
              className="instance-group"
              data-dragging={draggingId === inst.id}
            >
              <div
                className="instance-head"
                data-reorderable={instances.length > 1}
                onPointerDown={instances.length > 1 ? startDrag(inst.id) : undefined}
                onDoubleClick={toggleCollapsed(inst.id)}
              >
                <button
                  type="button"
                  className="collapse-toggle"
                  aria-label={collapsed.has(inst.id) ? `Expand ${inst.name}` : `Collapse ${inst.name}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={toggleCollapsed(inst.id)}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <svg
                    className="chevron"
                    data-collapsed={collapsed.has(inst.id)}
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <span className="pulse-sm" data-state={inst.ok ? 'live' : 'down'} aria-hidden="true" />
                <span className="instance-name">{inst.name}</span>
                {inst.ok && (
                  <span className="instance-totals">
                    {inst.totals.streams} {inst.totals.streams === 1 ? 'stream' : 'streams'} ·{' '}
                    {inst.totals.clients} {inst.totals.clients === 1 ? 'viewer' : 'viewers'}
                  </span>
                )}
                {instances.length > 1 && (
                  <svg className="grip" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                  </svg>
                )}
              </div>

              {!collapsed.has(inst.id) && !inst.ok && <p className="instance-error">{inst.error}</p>}

              {!collapsed.has(inst.id) && inst.ok && inst.streams.length > 0 && (
                <ul className="cards">
                  {inst.streams.map((s) => (
                    <Stream key={s.key} stream={s} instanceId={inst.id} />
                  ))}
                </ul>
              )}

              {!collapsed.has(inst.id) && inst.ok && inst.streams.length === 0 && (
                <p className="instance-empty">Nothing playing</p>
              )}
            </section>
          ))}
        </div>
      )}

      {data && instances.length === 0 && !error && (
        <div className="notice">
          <h2>No Dispatcharr instances configured</h2>
          <p>Add one from the menu (Settings) to start seeing live streams here.</p>
        </div>
      )}

      {error && (
        <div className="notice">
          <h2>{data ? 'Reconnecting' : 'Cannot reach the server'}</h2>
          <p>{error}</p>
          <button className="retry" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {staleSince && (
        <p className="foot">last good read {clock(new Date(staleSince).toISOString())}</p>
      )}
    </>
  );
}

function timeAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function eventMessage(e) {
  const who = e.user || e.ip || 'A viewer';
  switch (e.type) {
    case 'client_connect':
      return `${who} connected`;
    case 'client_disconnect': {
      const parts = [duration(e.durationSec), gigabytes(e.bytes)].filter(Boolean);
      return `${who} disconnected${parts.length ? ` — ${parts.join(', ')}` : ''}`;
    }
    case 'channel_start':
      return `Started${e.streamName ? ` — ${e.streamName}` : ''}`;
    case 'channel_stop':
      return `Stopped${duration(e.durationSec) ? ` after ${duration(e.durationSec)}` : ''}`;
    case 'channel_error':
      return `Error — ${e.errorType || 'unknown'}${e.attempts ? ` (attempt ${e.attempts})` : ''}`;
    case 'channel_buffering':
      return `Buffering${e.speed != null ? ` — ${e.speed.toFixed(2)}x realtime` : ''}`;
    case 'channel_reconnect':
      return `Reconnecting${e.attempts ? ` (attempt ${e.attempts}${e.maxAttempts ? `/${e.maxAttempts}` : ''})` : ''}`;
    default:
      return e.label;
  }
}

function HistoryView() {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/history?limit=60');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Server responded ${res.status}`);
      setEvents(body.events);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, HISTORY_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <>
      {events?.length > 0 && (
        <ul className="history">
          {events.map((e) => (
            <li key={e.id} className="history-row">
              <span className={`history-dot tone-${e.tone}`} aria-hidden="true" />
              <div className="history-body">
                <div className="history-main">
                  {e.instanceName && <span className="history-instance">{e.instanceName}</span>}
                  {e.channelName && <span className="history-channel">{e.channelName}</span>}
                  <span className="history-msg">{eventMessage(e)}</span>
                </div>
                <div className="history-time">{timeAgo(e.at)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {events && events.length === 0 && !error && (
        <div className="notice">
          <h2>No recent activity</h2>
          <p>Nothing logged yet — connects, disconnects and stream errors will show up here.</p>
        </div>
      )}

      {error && (
        <div className="notice">
          <h2>Cannot reach Dispatcharr</h2>
          <p>{error}</p>
          <button className="retry" type="button" onClick={load}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}

const EMPTY_FORM = { name: '', url: '', username: '', password: '' };

function InstanceForm({ initial, onSubmit, onCancel, submitLabel }) {
  const [form, setForm] = useState(initial || EMPTY_FORM);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const isEdit = Boolean(initial);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/instances/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      setTestResult(await res.json());
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="instance-form" onSubmit={submit}>
      <label>
        Name
        <input value={form.name} onChange={set('name')} placeholder="Living Room" />
      </label>
      <label>
        URL
        <input value={form.url} onChange={set('url')} placeholder="http://192.168.0.150:9090" required />
      </label>
      <label>
        Username
        <input value={form.username} onChange={set('username')} required />
      </label>
      <label>
        Password
        <input
          type="password"
          value={form.password}
          onChange={set('password')}
          placeholder={isEdit ? 'Leave blank to keep existing' : ''}
          required={!isEdit}
        />
      </label>

      {testResult && (
        <p className={`test-result ${testResult.ok ? 'ok' : 'fault'}`}>
          {testResult.ok ? 'Connected successfully.' : testResult.error}
        </p>
      )}
      {error && <p className="test-result fault">{error}</p>}

      <div className="form-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={test}
          disabled={testing || !form.url || !form.username}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <div className="form-actions-right">
          {onCancel && (
            <button type="button" className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function SettingsView() {
  const [instances, setInstances] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/instances');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Server responded ${res.status}`);
      setInstances(body.instances);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addInstance = async (form) => {
    const res = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Server responded ${res.status}`);
    setAdding(false);
    load();
  };

  const editInstance = async (id, form) => {
    const res = await fetch(`/api/instances/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Server responded ${res.status}`);
    setEditingId(null);
    load();
  };

  const deleteInstance = async (id) => {
    await fetch(`/api/instances/${id}`, { method: 'DELETE' });
    setConfirmDeleteId(null);
    load();
  };

  return (
    <>
      <h2 className="section-title">Dispatcharr instances</h2>

      {instances?.length > 0 && (
        <ul className="instance-list">
          {instances.map((inst) =>
            editingId === inst.id ? (
              <li key={inst.id} className="instance-list-row editing">
                <InstanceForm
                  initial={{ name: inst.name, url: inst.url, username: inst.username, password: '' }}
                  submitLabel="Save"
                  onCancel={() => setEditingId(null)}
                  onSubmit={(form) => editInstance(inst.id, form)}
                />
              </li>
            ) : (
              <li key={inst.id} className="instance-list-row">
                <div className="instance-list-info">
                  <div className="instance-list-name">{inst.name}</div>
                  <div className="instance-list-url">
                    {inst.url} · {inst.username}
                  </div>
                </div>
                <div className="instance-list-actions">
                  <button type="button" className="btn ghost" onClick={() => setEditingId(inst.id)}>
                    Edit
                  </button>
                  {confirmDeleteId === inst.id ? (
                    <>
                      <span className="confirm-label">Delete?</span>
                      <button type="button" className="btn fault" onClick={() => deleteInstance(inst.id)}>
                        Yes
                      </button>
                      <button type="button" className="btn ghost" onClick={() => setConfirmDeleteId(null)}>
                        No
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn ghost" onClick={() => setConfirmDeleteId(inst.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            )
          )}
        </ul>
      )}

      {instances && instances.length === 0 && !adding && (
        <p className="instance-empty">No instances yet — add one below.</p>
      )}

      {error && (
        <div className="notice">
          <h2>Cannot reach the server</h2>
          <p>{error}</p>
        </div>
      )}

      {adding ? (
        <InstanceForm submitLabel="Add" onCancel={() => setAdding(false)} onSubmit={addInstance} />
      ) : (
        <button type="button" className="btn primary add-instance" onClick={() => setAdding(true)}>
          + Add instance
        </button>
      )}
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState('live');
  const [navOpen, setNavOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [staleSince, setStaleSince] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/now');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Server responded ${res.status}`);
      setData(body);
      setError(null);
      setStaleSince(null);
    } catch (err) {
      setError(err.message);
      setStaleSince((prev) => prev ?? Date.now());
    }
  }, []);

  useEffect(() => {
    load();
    const tick = () => {
      if (document.visibilityState === 'visible') load();
    };
    timer.current = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer.current);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  const state = error ? (data ? 'stale' : 'down') : 'live';

  return (
    <>
      <header className="masthead">
        <button className="hamburger" type="button" onClick={() => setNavOpen(true)} aria-label="Open menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <h1>
          <span className="pulse" data-state={state} aria-hidden="true" />
          On now
        </h1>
        {tab === 'live' && data && <span className="foot">{clock(data.updatedAt)}</span>}
      </header>

      {navOpen && (
        <>
          <div className="scrim" onClick={() => setNavOpen(false)} />
          <nav className="drawer">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="drawer-item"
                data-active={tab === item.id}
                onClick={() => {
                  setTab(item.id);
                  setNavOpen(false);
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </>
      )}

      {tab === 'live' && <LiveView data={data} error={error} staleSince={staleSince} onRetry={load} />}
      {tab === 'history' && <HistoryView />}
      {tab === 'settings' && <SettingsView />}
    </>
  );
}
