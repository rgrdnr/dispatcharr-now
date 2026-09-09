import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 5000;

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

/** How far through the current programme we are, 0–100. */
function elapsedPercent(program) {
  if (!program?.start || !program?.end) return 0;
  const start = new Date(program.start).getTime();
  const end = new Date(program.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const pct = ((Date.now() - start) / (end - start)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function health(stream) {
  if (stream.state.includes('error') || stream.state.includes('fail')) return 'fault';
  if (stream.buffering || stream.state.includes('connect')) return 'warn';
  return 'ok';
}

function Stream({ stream }) {
  const pct = elapsedPercent(stream.program);
  const bar = health(stream);
  // Meter is scaled against 12 Mbps, roughly a good HD feed.
  const level = Math.min(100, ((stream.bitrateKbps || 0) / 12000) * 100);

  return (
    <li
      className="row"
      data-idle={stream.clientCount === 0}
      style={{ '--elapsed': `${pct}%` }}
    >
      <div className="head">
        <div className="badge">
          {stream.logo ? (
            <img src={`/api/logo/${stream.channelId}`} alt="" loading="lazy" />
          ) : (
            <span>{stream.number ?? stream.name.slice(0, 2)}</span>
          )}
        </div>

        <div className="title">
          <h2 className="channel">{stream.name}</h2>
          <p className="programme">
            {stream.program?.title ? (
              <>
                {stream.program.title}
                {stream.program.end ? ` until ${clock(stream.program.end)}` : ''}
              </>
            ) : (
              <em>No guide data</em>
            )}
          </p>
        </div>

        <div className="viewers">
          <b>{stream.clientCount}</b>
          <span>{stream.clientCount === 1 ? 'viewer' : 'viewers'}</span>
        </div>
      </div>

      <div className="meta">
        {bar === 'fault' && <span className="chip fault">Stream error</span>}
        {bar === 'warn' && <span className="chip warn">Buffering</span>}
        {mbps(stream.bitrateKbps) && <span className="chip">{mbps(stream.bitrateKbps)}</span>}
        {stream.resolution && <span className="chip">{stream.resolution}</span>}
        {stream.videoCodec && <span className="chip">{stream.videoCodec}</span>}
        {duration(stream.uptimeSec) && <span className="chip">up {duration(stream.uptimeSec)}</span>}
        {stream.streamName && stream.streamName !== stream.name && (
          <span className="chip">{stream.streamName}</span>
        )}
      </div>

      {stream.clients.length > 0 && (
        <ul className="clients">
          {stream.clients.map((c) => (
            <li key={c.id}>
              <span>{c.user || c.ip || 'Unknown client'}</span>
              <span>{duration(c.connectedSec) || ''}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="signal" data-health={bar}>
        <i style={{ width: `${level}%` }} />
      </div>
    </li>
  );
}

export default function App() {
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
  const totals = data?.totals;

  return (
    <>
      <header className="masthead">
        <h1>
          <span className="pulse" data-state={state} aria-hidden="true" />
          On now
        </h1>
        {data && <span className="foot">{clock(data.updatedAt)}</span>}
      </header>

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

      {data?.streams?.length > 0 && (
        <ul className="rows">
          {data.streams.map((s) => (
            <Stream key={s.key} stream={s} />
          ))}
        </ul>
      )}

      {data && data.streams.length === 0 && !error && (
        <div className="notice">
          <h2>Nothing is streaming</h2>
          <p>
            Dispatcharr has no active connections right now. Start a channel on any client and
            it will appear here within a few seconds.
          </p>
        </div>
      )}

      {error && (
        <div className="notice">
          <h2>{data ? 'Reconnecting to Dispatcharr' : 'Cannot reach Dispatcharr'}</h2>
          <p>{error}</p>
          <button className="retry" type="button" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {data?.source && (
        <p className="foot">
          Reading <code>{data.source}</code>
          {staleSince ? ` — last good read ${clock(new Date(staleSince).toISOString())}` : ''}
        </p>
      )}
    </>
  );
}
