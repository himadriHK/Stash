# Stash Host Node

Node 22+ ESM TypeScript host for Stash uploads.

**Scope:** Phases 1-2 only. This scaffold provides configuration, logging, SQLite migrations, v2 request contracts, JWT verification, Kafka contracts/ingest, repositories, an outbox dispatcher skeleton, health checks, and a minimal Fastify server with `GET /health/live` and `GET /api/health`.

Not implemented yet: S3 download, media conversion/thumbnails, worker pool, SSE/REST dashboard API, React UI, Docker, and live Kafka/S3 verification. The legacy `StashHost.Functions` project is unchanged.

## Requirements

- Node 22+ (Node 24 tested locally)
- A local, non-network disk for `DB_PATH` and `LOCAL_ROOT_PATH`

## Setup

```bash
npm install
cp .env.example .env
# set LOCAL_ROOT_PATH, JWT_SIGNING_KEY, and either disable Kafka/S3 or provide their settings
npm run dev
```

## Commands

- `npm run dev` - start the minimal server with `tsx watch`
- `npm run build` - bundle `src/server/index.ts` to `dist/server`
- `npm start` - run the built server
- `npm run typecheck` - TypeScript strict check
- `npm test` - Vitest unit/integration tests
- `npm run test:watch` - Vitest watch mode

## Notes

Kafka and S3 clients are not started by the server yet. Ingest, outbox dispatch, and health checks are library code exercised by tests; no live broker or bucket is contacted.
