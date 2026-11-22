# Stash Host Node

Node 22+ ESM TypeScript host for Stash uploads.

**Scope:** configuration, logging, SQLite migrations (v1-v3), v2 request contracts, JWT verification, Kafka contracts/ingest, repositories, outbox dispatcher and media pipeline library code, health checks, and a Fastify server that serves a realtime browser dashboard and settings editor plus JSON and SSE APIs.

The server starts and supervises the background pipeline: the Kafka request consumer, ingest, the worker pool, the outbox dispatcher and the response producer are all wired from the server entry point (`src/pipeline/runtime.ts`), and stop on shutdown. Kafka connection failures are logged, retried every 10 seconds, and shown on the dashboard instead of blocking startup. The legacy `StashHost.Functions` project is unchanged.

## Requirements

- Node 22+ (Node 24 tested locally)
- A local, non-network disk for `DB_PATH` and `LOCAL_ROOT_PATH`

## Setup

```bash
npm install
cp .env.example .env
# set LOCAL_ROOT_PATH and JWT_SIGNING_KEY, and either disable Kafka/S3 or provide their settings
npm run dev
```

The dashboard is available after `npm run dev` or `npm start` at `http://localhost:8080/` (or the configured `HOST`/`PORT`).

## Commands

- `npm run dev` - start the server with `tsx watch`
- `npm run build` - bundle `src/server/index.ts` to `dist/server`
- `npm start` - run the built server
- `npm run typecheck` - TypeScript strict check
- `npm test` - Vitest unit/integration tests (includes the dashboard service, settings catalog/service, env-file writer, and HTTP API suites)
- `npm run test:watch` - Vitest watch mode

## Browser UI

The host serves a static, same-origin UI on the configured host/port (default `http://localhost:8080`). There is no build step, no CDN, and no external fonts: HTML lives in `public/` and CSS/JS in `public/assets/`.

The dashboard is live: the browser opens an SSE stream at `GET /api/dashboard/stream`, which pushes a full snapshot about every 2 seconds (`dashboard` event, `{ ok: true, data }`, `retry: 2000`). A Live/Reconnecting/Polling/Offline indicator shows the connection state; the stream pauses while the tab is hidden and reconnects automatically. If `EventSource` is unavailable, the UI falls back to 5-second polling. Manual Refresh still fetches `GET /api/dashboard`.

| Page | URL | Contents |
| --- | --- | --- |
| Dashboard | `/` (default page) | Service status, uptime and version; job KPIs; 24-hour activity chart; pipeline/queue/outbox stats (including Kafka consumer state and last consumed message); storage free/total; recent uploads; recent events; health components (`database`, `temp_dir`, `config`); Kafka/S3/worker configuration. An empty database is handled. If the pipeline runtime is not started at all, the Pipeline card shows a notice. The Health card notes that Kafka/S3 settings are configured but runtime connectivity checks are handled by the pipeline and are not part of the host probe. |
| Settings | `/settings` | All 76 validated environment settings grouped by runtime, Kafka, S3, JWT, worker, media, and dashboard. Each field shows its label, description, validation, current source (`environment`, `.env`, or `default`), and a restart badge. Secret values are never returned; only set/not-set state is shown. |

The settings page writes `stash_host_node/.env` atomically and keeps the previous file as `.env.bak`; comments and unknown keys are preserved. Saving validates every field and reports per-field errors. All settings except `LOG_LEVEL` require a host restart (`LOG_LEVEL` applies immediately); the UI shows a banner with the exact restart instruction.

### Authentication

Set `DASHBOARD_AUTH_ENABLED=true` to require HTTP Basic auth for the UI and APIs. `DASHBOARD_USER` and `DASHBOARD_PASSWORD` are then required, and the password must be at least 12 characters. `GET /health/live` stays open. Changing auth settings requires a restart.

### HTTP routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/` | Dashboard page (default route) |
| `GET` | `/settings`, `/settings/` | Settings page |
| `GET` | `/assets/*`, `/favicon.svg` | Static UI assets |
| `GET` | `/health/live` | Liveness (always unauthenticated) |
| `GET` | `/api/health` | On-demand component health report for `database`, `temp_dir`, and `config` (uncached) |
| `GET` | `/api/dashboard` | Dashboard JSON snapshot (manual refresh) |
| `GET` | `/api/dashboard/stream` | SSE stream of the dashboard snapshot (~2 s, event `dashboard`, `retry: 2000`) |
| `GET` | `/api/settings` | Settings catalog with runtime values and sources |
| `PUT` | `/api/settings` | Validate and persist settings to `.env`; returns field errors |

`PUT /api/settings` accepts only same-origin JSON. The UI is served with a strict same-origin Content-Security-Policy; scripts and styles are external files under `/assets/`.

Dashboard snapshots cache health results for about 10 seconds so the ~2-second stream does not write a temp-file probe on every tick. `GET /api/health` always runs the checks on demand and is not cached.

## Project structure

```
stash_host_node/
├── public/          # dashboard/settings HTML, favicon, assets/ (CSS + JS)
├── src/
│   ├── api/         # /api/dashboard and /api/settings routes
│   ├── config/      # env loading and the 76-setting catalog
│   ├── dashboard/   # dashboard snapshot service
│   ├── server/      # Fastify app, static UI, Basic auth
│   └── settings/    # settings service and atomic .env writer
└── test/            # Vitest suites incl. HTTP APIs, dashboard, settings
```

## Notes

The server connects to Kafka at startup when `KAFKA_ENABLED=true` (consumer, producer and outbox dispatcher) and starts `WORKER_CONCURRENCY` pipeline workers when `WORKER_ENABLED=true`; both settings are independent. The host health probe covers only `database`, `temp_dir`, and `config`; Kafka/S3 connectivity surfaces through the Pipeline card and the server log, not the health probe, so a broker outage leaves the dashboard reachable.
