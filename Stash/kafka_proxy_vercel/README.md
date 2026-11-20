# Stash Kafka Proxy (Vercel Functions)

A single public HTTPS endpoint for the **React Native Stash app**, which cannot
open a Kafka connection itself. The app posts messages here; the function
produces them to Kafka with the **native Confluent client**
(`@confluentinc/kafka-javascript`, librdkafka) — not the REST Proxy API. New
`stash.upload.response` records are picked up by a **polling loop in the app**
that calls `GET /api/messages`.

```
react_native_stash
  POST /api/messages            Bearer <Stash access token>
  GET  /api/messages?topic=…    poll for new upload responses
        │
        ▼
  Vercel Function (this project, Node runtime)
    • verifies the HS256 access token (node:crypto)
    • topic allowlists, 1 MiB body cap, per-device consumer group
    • injects Authorization / X-User-Id / X-Device-Id / X-Correlation-Id headers
    • producer reused across warm invocations; one bounded Kafka poll per request
        │  librdkafka, SASL_SSL/SCRAM
        ▼
  Aiven / Confluent Kafka ──► StashHost.Functions ──► stash.upload.response
```

Kafka credentials and the JWT signing key exist **only** in the deployment's
environment; the device never sees a broker address.

## Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | none | Liveness; never touches Kafka |
| `POST /api/messages` | Bearer JWT | Produce one record |
| `GET /api/messages?topic=…&timeoutMs=…&maxRecords=…` | Bearer JWT | Bounded poll for new records |
| `OPTIONS /api/messages` | none | CORS preflight (Expo web) |

`POST` body:

```json
{
  "topic": "stash.upload.request",
  "key": "<sha256 hex>",
  "value": { "messageId": "…", "fileId": "…" },
  "headers": { "X-Message-Version": "1", "X-Correlation-Id": "…" }
}
```

`value` may be an object/array (sent as JSON text) or a string. Client-supplied
`Authorization`, `X-User-Id` and `X-Device-Id` are **always overwritten** from
the verified token; `X-Correlation-Id` and `X-Message-Version: 1` are defaulted.

`202` response: `{ "ok": true, "topic": "…", "partition": 0, "offset": 42 }`

`GET` response (`200`, empty poll included):

```json
{
  "records": [
    {
      "topic": "stash.upload.response",
      "key": "<sha256 hex>",
      "value": "{\"fileId\":\"…\",\"status\":\"COMPLETED\"}",
      "headers": { "X-Correlation-Id": "…" },
      "partition": 0,
      "offset": 42
    }
  ],
  "topic": "stash.upload.response",
  "group": "stash-mobile-<deviceId>",
  "polledAt": "2026-11-11T09:00:00.000Z"
}
```

The consumer group is derived from the token's `deviceId` claim, never from the
query string. Errors use `{ "ok": false, "error": { "code": "…", "message": "…" } }`
with `400 invalid_request`, `401 invalid_token` / `token_expired`,
`403 topic_not_allowed`, `405 method_not_allowed`, `413 body_too_large`,
`500 proxy_misconfigured`, `502 upstream_error`.

## Configuration

Copy `.env.example` to `.env` for `vercel dev`; in production set the same names
under **Vercel → Settings → Environment Variables**.

| Variable | Default | Notes |
| --- | --- | --- |
| `KAFKA_BOOTSTRAP_SERVERS` | — (required) | Comma-separated `host:port` (Aiven SASL port) |
| `KAFKA_SECURITY_PROTOCOL` | `SASL_SSL` | `SASL_SSL`, `SSL`, `SASL_PLAINTEXT`, `PLAINTEXT` |
| `KAFKA_SASL_MECHANISM` | `scram-sha-256` | `plain`, `scram-sha-256`, `scram-sha-512` |
| `KAFKA_USERNAME` / `KAFKA_PASSWORD` | — (required for SASL) | Service user secret |
| `KAFKA_CLIENT_ID` | `stash-kafka-proxy-vercel` | librdkafka client id |
| `KAFKA_CONNECTION_TIMEOUT_MS` | `10000` | Broker connect timeout |
| `KAFKA_REQUEST_TIMEOUT_MS` | `20000` | Produce/request timeout |
| `KAFKA_CONSUMER_SESSION_TIMEOUT_MS` | `15000` | Group session + rebalance timeout |
| `KAFKA_CONSUMER_HEARTBEAT_MS` | `3000` | Must stay below a third of the session timeout |
| `JWT_SIGNING_KEY` | — (required) | Must equal `Auth:Jwt:SigningKey` of Identity API/Functions |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `stash-auth` / `stash-app` | Token validation |
| `ALLOWED_PRODUCE_TOPICS` | `stash.upload.request,stash.dlq` | Comma-separated allowlist |
| `ALLOWED_CONSUME_TOPICS` | `stash.upload.response` | Comma-separated allowlist |
| `CONSUMER_GROUP_PREFIX` | `stash-mobile` | Final group: `<prefix>-<deviceId>` |
| `CORS_ALLOWED_ORIGINS` | `*` | Needed only by the Expo web build |
| `MAX_BODY_BYTES` | `1048576` | Request body cap |
| `POLL_TIMEOUT_MS` | `8000` | Upper bound for one poll's server-side wait |

Aiven brokers signed by the project CA are not trusted by librdkafka's default
store: enable **public CA certificates** on the Aiven service (the same setting
`StashHost.Functions` needs), or the TLS handshake fails.

## Local development

```bash
npm install          # postinstall fetches the prebuilt librdkafka binding
npm run typecheck
npm test
npx vercel dev       # serves http://localhost:3000
```

`npm install` may report that npm blocked `@confluentinc/kafka-javascript`'s
install script (npm 11+). `scripts/ensure-kafka-binary.mjs` then downloads the
prebuilt binding itself; if it cannot, run `npm rebuild @confluentinc/kafka-javascript`.

Smoke test (mint a token with the same signing key the Identity API uses):

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok","service":"stash-kafka-proxy-vercel","time":"…"}

curl -s -X POST http://localhost:3000/api/messages \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"topic":"stash.upload.request","key":"<sha256>","value":{"fileId":"<sha256>"}}'
# {"ok":true,"topic":"stash.upload.request","partition":0,"offset":42}

curl -s "http://localhost:3000/api/messages?topic=stash.upload.response&timeoutMs=5000" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# {"records":[],"topic":"stash.upload.response","group":"stash-mobile-<deviceId>","polledAt":"…"}
```

## Deploy

```bash
npx vercel link
npx vercel env add KAFKA_BOOTSTRAP_SERVERS production   # repeat for each variable
npx vercel --prod
```

Then point the app at the deployment: in
`react_native_stash/src/config/appconfig.json` set
`Kafka.Proxy.BaseUrl` to the deployment URL and `Kafka.Proxy.Enabled` to `true`.
Until then the app keeps using its direct REST transport.

### Native binary packaging

`@confluentinc/kafka-javascript` is a native addon: it loads
`build/Release/confluent-kafka-javascript.node`, which is downloaded by
node-pre-gyp for the build machine's platform (linux-x64/glibc on Vercel).
Vercel's Node File Trace cannot see that dynamic load, so `vercel.json` pins it
with `functions["api/messages.ts"].includeFiles`. If a deployment fails at
runtime with *"Could not locate the bindings file"*, check that the function
bundle contains `node_modules/@confluentinc/kafka-javascript/build/Release/`, and
that the project's Node version matches a prebuilt ABI (Node 22 is set in
`package.json`).

## Serverless behaviour worth knowing

- **Producer reuse.** The producer connects once per warm instance and is
  reused; a failed send drops it so the next request reconnects.
- **One poll per request.** A serverless function cannot hold a consumer open,
  so every `GET` joins the device's group, drains what is available, commits,
  and disconnects. The first poll of a new device replays from `earliest`;
  that is why the app de-duplicates by `topic/partition/offset`.
- **Poll cost.** Each poll pays a group join (roughly 0.5–2 s depending on
  broker latency) plus cold start. Poll every 15 s from the app rather than in a
  tight loop.
- **`maxDuration`.** `api/messages.ts` is configured for 60 s so an 8 s poll plus
  connection setup always fits.

## Limits

- At-most-once per poll window: offsets commit after each batch, so a crash
  between processing and commit replays records (the app tolerates duplicates).
- `stash.upload.response` still has no per-user filtering: every device consumes
  the topic and matches its own `fileId`.
- No push/websockets — the requirement is polling.
- The app's direct REST transport is kept as a fallback for local dev setups.

## Layout

```
api/health.ts          GET /api/health
api/messages.ts        POST/GET/OPTIONS /api/messages
src/config.ts          env → typed config, fail fast
src/http.ts            HttpError, JSON, CORS, body limits
src/auth.ts            HS256 verification, claim extraction
src/topics.ts          topic allowlists
src/records.ts         produce parsing, header policy, record mapping
src/gateway.ts         injectable KafkaGateway contract
src/kafka.ts           Confluent producer + bounded poll consumer
src/messages.ts        route logic (no native import → unit-testable)
test/                  node:test suites (auth, record policy, routing)
```
