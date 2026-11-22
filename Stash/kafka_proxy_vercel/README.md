# Stash Vercel Functions (Identity API + Kafka proxy)

Two public HTTPS endpoints for the **React Native Stash app**, deployed as
Vercel Functions from one project:

- **Identity API** (`/api/auth/*`) — register, login, refresh, revoke and health
  for the Stash account system, backed by MongoDB.
- **Kafka proxy** (`/api/messages`, `/api/health`) — lets the app produce and
  poll messages without opening a Kafka connection itself. It uses the **native
  Confluent client** (`@confluentinc/kafka-javascript`, librdkafka), not the
  REST Proxy API.

```
react_native_stash
  POST /api/auth/register|login|refresh|revoke   Identity API
  POST /api/messages              Bearer <Stash access token>
  GET  /api/messages?topic=…      poll for new upload responses
        │
        ▼
  Vercel Functions (this project, Node runtime)
    • Identity: PBKDF2-SHA256 + HS256 access tokens + MongoDB
    • Proxy: verifies the same HS256 token with node:crypto
    • topic allowlists, body caps, per-device consumer group
        │
        ├── MongoDB (users, devices, refresh_tokens)
        │
        └── Aiven / Confluent Kafka ──► Stash host/consumer (legacy Functions host is untouched)
```

The Identity API is self-contained and does not call `StashHost.Functions`; the legacy Functions host is intentionally not part of this change.

Kafka credentials, the MongoDB URI, and the JWT signing key exist **only** in
the deployment's environment; the device never sees a broker address or
database connection string.

## Identity API

Routes are served by the catch-all `api/auth/[...path].ts`. Responses are JSON
with `Cache-Control: no-store`; errors always use the flat envelope
`{ "error": "message" }` so the React Native client can read `error` directly.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/auth/health` | none | Liveness; never touches MongoDB |
| `POST /api/auth/register` | none | Create a user + device, return a token pair |
| `POST /api/auth/login` | none | Authenticate; auto-registers a new device |
| `POST /api/auth/refresh` | refresh token body | Rotate the refresh token and issue a new pair |
| `POST /api/auth/revoke` | Bearer JWT | Revoke the authenticated user's device |
| `OPTIONS /api/auth/*` | none | CORS preflight (Expo web) |

Request fields are `{ email, password, deviceId }` for register/login,
`{ refreshToken }` for refresh, and `{ deviceId }` for revoke. Success returns
exactly these camelCase fields:

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<base64>",
  "expiresAt": "2026-11-21T03:15:00.000Z",
  "userId": "<user id hex string>",
  "deviceId": "<device id>"
}
```

Registration validates email, an 8..1024 character password, and a non-empty
device ID. Email is normalized with `trim()` + `toLowerCase()`. Duplicate emails
return `409`; invalid credentials and revoked devices return `401`. Refresh
rotation is atomic: a refresh token can be consumed once, and reuse fails with
`401`.

Example:

```bash
curl -s -X POST https://stash-proxy.vercel.app/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"Password123!","deviceId":"device-1"}'

curl -s -X POST https://stash-proxy.vercel.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"Password123!","deviceId":"device-1"}'

curl -s -X POST https://stash-proxy.vercel.app/api/auth/revoke \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"device-1"}'
# {"message":"Device revoked successfully"}
```

The Vercel Identity API replaces `StashHost.IdentityApi` for deployed use. The
.NET project remains the local/reference implementation and is not modified by
this project.

## Kafka proxy

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
      "value": "{\"fileId\":\"…\",\"status\":\"COMPLETED\",\"deviceId\":\"<deviceId>\",\"userId\":\"<userId>\"}",
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
query string. `records` contains only records whose JSON `deviceId` matches the
token's device (and whose `userId` matches when present); records with no usable
`deviceId` are excluded. The gateway may still read other devices' records before
they are filtered out (read amplification), and it commits offsets before the app
applies a record — an ACK/inbox protocol is a known follow-up.

Kafka proxy errors use the nested
`{ "ok": false, "error": { "code": "…", "message": "…" } }` envelope with
`400 invalid_request`, `401 invalid_token` / `token_expired`,
`403 topic_not_allowed`, `405 method_not_allowed`, `413 body_too_large`,
`500 proxy_misconfigured`, `502 upstream_error`. Identity routes use the flat
`{ "error": "…" }` envelope instead.

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
| `MONGODB_URI` | — (required for Identity) | Mongo connection string; secret |
| `MONGODB_DATABASE` | `stash` | Database holding `users`, `devices`, `refresh_tokens` |
| `JWT_SIGNING_KEY` | — (required) | Signs Identity tokens and validates proxy tokens; must match the .NET services |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `stash-auth` / `stash-app` | Shared token claims |
| `AUTH_ACCESS_TOKEN_EXPIRY_MINUTES` | `15` | Clamped 1..1440 |
| `AUTH_REFRESH_TOKEN_EXPIRY_DAYS` | `7` | Clamped 1..365 |
| `AUTH_MAX_BODY_BYTES` | `65536` | Identity request body cap, clamped 1024..1048576 |
| `ALLOWED_PRODUCE_TOPICS` | `stash.upload.request,stash.dlq` | Comma-separated allowlist |
| `ALLOWED_CONSUME_TOPICS` | `stash.upload.response` | Comma-separated allowlist |
| `CONSUMER_GROUP_PREFIX` | `stash-mobile` | Final group: `<prefix>-<deviceId>` |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowlist; applies to Identity and proxy |
| `MAX_BODY_BYTES` | `1048576` | Kafka proxy request body cap |
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

`npm run dev:local` is the recommended local option. It runs a plain Node HTTP
server that serves the same routes at `http://127.0.0.1:3000` (override with
`HOST` and `PORT`) and needs neither `vercel dev` nor a Vercel login/link.
`/api/auth/*` requires `MONGODB_URI` and `JWT_SIGNING_KEY`; `/api/messages`
requires the Kafka variables. The server lazy-loads the native Kafka binding, so
`/api/health` and `/api/auth/health` still start without a broker; only
broker-backed `/api/messages` calls fail.

`npm install` may report that npm blocked `@confluentinc/kafka-javascript`'s
install script (npm 11+). `scripts/ensure-kafka-binary.mjs` then downloads the
prebuilt binding itself; if it cannot, run `npm rebuild @confluentinc/kafka-javascript`.

Smoke test (mint a token with the same signing key the Identity API uses):

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok","service":"stash-kafka-proxy-vercel","time":"…"}

curl -s http://localhost:3000/api/auth/health
# {"status":"healthy","timestamp":"…"}

curl -s -X POST http://localhost:3000/api/messages \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"topic":"stash.upload.request","key":"<sha256>","value":{"fileId":"<sha256>"}}'
# {"ok":true,"topic":"stash.upload.request","partition":0,"offset":42}

curl -s "http://localhost:3000/api/messages?topic=stash.upload.response&timeoutMs=5000" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# {"records":[],"topic":"stash.upload.response","group":"stash-mobile-<deviceId>","polledAt":"…"}
```

The default test suite uses an in-memory `IdentityStore`; it never connects to
MongoDB and does not need Kafka.

## Deploy

```bash
npx vercel link
npx vercel env add MONGODB_URI production          # plus MONGODB_DATABASE
npx vercel env add JWT_SIGNING_KEY production      # plus JWT_ISSUER / JWT_AUDIENCE
npx vercel env add KAFKA_BOOTSTRAP_SERVERS production   # repeat for each variable
npx vercel --prod
```

Then point the app at the deployment:

- Identity: set `EXPO_PUBLIC_IDENTITY_API_BASE_URL` to the deployment origin
  (for example `https://stash-proxy.vercel.app`; no trailing slash is needed).
  Rebuild the app because `EXPO_PUBLIC_*` values are inlined at build time.
- Kafka proxy: in `react_native_stash/src/config/appconfig.json` set
  `Kafka.Proxy.BaseUrl` to the deployment URL.

`JWT_SIGNING_KEY`, `JWT_ISSUER`, and `JWT_AUDIENCE` must match the Kafka proxy
and any host still validating tokens. The Vercel Identity API is the deployed
implementation; `StashHost.IdentityApi` stays available as a local/reference
service and is intentionally not modified.

MongoDB Atlas must allow the Vercel function's egress. Vercel IPs are dynamic unless Secure Compute/private networking is used, so either allow the deployment CIDR/0.0.0.0/0 with strong database credentials and TLS, or configure Atlas Private Endpoint/Vercel Secure Compute. `MONGODB_URI` should include TLS for Atlas (`mongodb+srv://…`).

### Mongo indexes and legacy data

The store creates these indexes lazily on a cold start (cached per warm
instance), or you can run them explicitly in a migration step:

- unique `users.email` (`ux_users_email`)
- unique `devices.(userId, deviceId)` (`ux_devices_user_device`)
- unique `refresh_tokens.token` (`ux_refresh_tokens_token`)
- lookup indexes on `devices.userId` and `refresh_tokens.(userId, deviceId)`

The .NET service only created the unique email index. If the existing
`devices` or `refresh_tokens` collections contain duplicates, the new unique
indexes fail with `E11000`. Check and resolve duplicates before deploying:

```js
db.users.aggregate([
  { $group: { _id: '$email', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);
db.devices.aggregate([
  { $group: { _id: { userId: '$userId', deviceId: '$deviceId' }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);
db.refresh_tokens.aggregate([
  { $group: { _id: '$token', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);
```

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
  connection setup always fits; the auth function is capped at 15 s.
- **Mongo pool.** Each warm instance keeps one cached `MongoClient` with
  `maxPoolSize: 5`. Serverless concurrency can still exhaust Atlas connection
  limits; monitor the cluster and raise tiers as needed.

## Limits and security

- **Rate limiting.** Identity endpoints have no distributed rate limiting.
  In-memory counters are unreliable in serverless functions; use Vercel
  Firewall and/or Upstash/Redis for login/register throttling.
- **Refresh tokens are plaintext.** They are stored verbatim in
  `refresh_tokens.token` for compatibility with the .NET service and existing
  rows. Hashing them would require a dual-read migration.
- **Unique-index migration risk.** See the duplicate checks above; creating the
  new unique indexes over legacy data can fail until duplicates are resolved.
- **No access-token revocation list.** Revoking a device invalidates its refresh
  tokens and device row, but already-issued access tokens remain valid until
  `exp`, matching the .NET service and the Kafka proxy verifier.
- **Mixed-writer window.** The Vercel refresh rotation is atomic; the .NET
  implementation is not. Keep the cutover window short if both services can
  issue tokens.
- **Distributed secret handling.** MongoDB and JWT secrets are only in the
  deployment environment; error responses never include stack traces, driver
  messages, connection strings, tokens, or password hashes.
- **Compaction window.** Kafka offsets commit after each poll batch, before the
  app applies a record, so a crash between apply and commit replays records (the
  app tolerates duplicates). An ACK/inbox protocol to commit only after delivery
  is still a known gap.
- `stash.upload.response` is filtered per device by this proxy: a poll returns
  only records with the token's `deviceId` and a matching `userId` when present,
  and drops records with no usable `deviceId`. The gateway can still read other
  devices' records before dropping them, so read amplification remains.
- No push/websockets — the requirement is polling.

## Layout

```
api/auth/[...path].ts    POST /api/auth/*, GET /api/auth/health
api/health.ts           GET /api/health
api/messages.ts         POST/GET/OPTIONS /api/messages
src/config.ts           Kafka proxy env → typed config, fail fast
src/http.ts             HttpError, JSON, CORS, body limits
src/auth.ts             HS256 verification, claim extraction
src/identity/config.ts  Identity env → typed config, fail fast
src/identity/models.ts  user/device/refresh-token/token-pair types
src/identity/store.ts   IdentityStore contract + duplicate-email error
src/identity/password.ts PBKDF2-SHA256 hash/verify + dummy hash
src/identity/jwt.ts     HS256 access-token signing
src/identity/mongoStore.ts Mongo store + cached connection/indexes
src/identity/service.ts register/login/refresh/revoke logic
src/identity/handler.ts routes, validation, flat envelope, CORS
src/topics.ts           topic allowlists
src/records.ts          produce parsing, header policy, record mapping
src/gateway.ts          injectable KafkaGateway contract
src/kafka.ts            Confluent producer + bounded poll consumer
src/messages.ts         route logic (no native import → unit-testable)
test/identity.test.ts   Identity API contract tests (in-memory store)
test/                   other node:test suites (auth, record policy, routing)
```
