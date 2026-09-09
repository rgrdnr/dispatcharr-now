# On now — a phone-friendly view of Dispatcharr

A small dashboard for seeing what's actually playing through Dispatcharr: which
channels are up, who's watching, what programme is on, and whether anything is
struggling. Built as a PWA so it installs to the home screen without Xcode or a
developer certificate.

Express holds the Dispatcharr credentials and normalizes its API; the React
front end only renders.

## Run it

```bash
cp .env.example .env      # set DISPATCHARR_USER / DISPATCHARR_PASS
docker compose up -d --build
```

Then open `http://<mac-mini>:8790`. On iOS, Share → Add to Home Screen gives you
a standalone app with no browser chrome.

Use an **admin** account. Recent Dispatcharr releases restrict live connection
telemetry and the system-events API to admins; a standard user gets 403 on the
stats endpoints.

## Local development

```bash
cd server && npm install && DISPATCHARR_URL=http://192.168.0.149:9090 \
  DISPATCHARR_USER=admin DISPATCHARR_PASS=... npm run dev
cd web && npm install && npm run dev     # proxies /api to :8790
```

## How it talks to Dispatcharr

| What | Endpoint |
| --- | --- |
| Auth | `POST /api/accounts/token/`, refreshed via `/api/accounts/token/refresh/` |
| Active streams | `/proxy/ts/status`, falling back to `/api/channels/stats/` and two other candidates |
| Channel names, numbers, logos | `/api/channels/channels/` (cached 5 min) |
| Current programme | `POST /api/epg/current-programs/` |

The live-stats endpoint has moved between releases, so `fetchStatus()` probes the
candidate list on first use and remembers whichever answers. Field names are read
through a `pick()` helper with several aliases each, so a rename upstream degrades
one field to null rather than breaking the page.

### Confirming the shape on your instance

```bash
curl -s localhost:8790/api/debug/raw | jq
```

That returns the untouched upstream payload plus which path served it. If a field
shows as null in the UI, add its real key to the alias list in
`server/src/dispatcharr.js` — everything funnels through `normalizeStatus()`.

Your Swagger UI at `http://192.168.0.149:9090/swagger/` is the authoritative
reference for your build.

## Design notes

Each row fills left to right as the current programme elapses, so a glance tells
you how far into something a viewer is. The thin bar underneath is bitrate,
scaled against 12 Mbps, and changes colour when a stream is buffering or errored.
Rows with no viewers dim but stay visible, since a channel that's up with nobody
watching is usually worth noticing.

## Worth adding later

- Swap polling for the WebSocket feed — Dispatcharr pushes client connect and
  disconnect events, so the viewer list could update instantly and polling could
  drop to stats ticks only.
- A preview button per row, mirroring the one on Dispatcharr's own stats page.
- History: write each poll to SQLite and chart bandwidth over the evening.
