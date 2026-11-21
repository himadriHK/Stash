# Stash Identity API — Vercel Function Implementation Plan

Status: **Phases 0–4 complete for the local Vercel implementation. Unit tests and typecheck pass; live MongoDB/Vercel/RN smoke testing was not performed.**

This document plans moving `StashHost.IdentityApi` into the existing
`kafka_proxy_vercel` Vercel project as `api/auth/[...path].ts`. The .NET service
remains the reference implementation; this plan must not change the auth
contract, token shape, or password format that existing users and React Native
clients already depend on.

## 1. Scope and decision

- Host the Identity API as a catch-all Vercel function in this project:
  `api/auth/[...path].ts`.
- Reuse the project's existing `JWT_SIGNING_KEY`, `JWT_ISSUER`,
  `JWT_AUDIENCE`, `CORS_ALLOWED_ORIGINS`, and HTTP helpers so the Identity API
  and the Kafka proxy agree on tokens and CORS behavior.
- Persist to the existing MongoDB data (`users`, `devices`,
  `refresh_tokens`) using the official `mongodb` Node driver.
- Preserve the existing auth contract and PBKDF2-SHA256 hash format so
  existing users and React Native clients keep working.
- **`StashHost.Functions` is not modified.** The .NET Identity API remains
  available as a local/reference implementation. No host project, route,
  configuration, or token validation is changed by this work.
- The existing routes `GET /api/health` and `POST|GET /api/messages` keep their
  current behavior; the new catch-all lives only under `/api/auth/*`.
- No JWT library is added. Signing and verification use `node:crypto`, matching
  the proxy's existing `src/auth.ts` verifier.

Out of scope for the implementation phases described here: distributed rate
limiting, refresh-token hashing, MFA, email verification, password reset, and
multi-region Mongo topology changes.

## 2. Contract parity table

The catch-all maps the last path segment to the routes below. All responses are
`Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`.
Token-pair responses use exactly these camelCase fields:

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<base64>",
  "expiresAt": "2026-11-21T03:15:00.000Z",
  "userId": "<user id hex string>",
  "deviceId": "<device id>"
}
```

| Endpoint | Method | Request | Success | Error behavior |
| --- | --- | --- | --- | --- |
| `/api/auth/register` | `POST` | `{ "email": string, "password": string, "deviceId": string }` | `200` token pair (not `201`, matching `Results.Ok`) | `400` validation: `Email and password are required`; `Device ID is required`; `Email is not valid`; `Password must be at least 8 characters`. `409` `A user with this email already exists` on duplicate. `500` generic if Mongo/config fails. |
| `/api/auth/login` | `POST` | `{ "email": string, "password": string, "deviceId": string }` | `200` token pair; a first login from an unknown device auto-registers that device for the user | `400` `Email, password and device ID are required`; `401` `Invalid email or password` (unknown user, inactive user, or bad password); `401` `Device has been revoked`; `500` generic. |
| `/api/auth/refresh` | `POST` | `{ "refreshToken": string }` | `200` rotated token pair (old token consumed) | `400` `Refresh token is required`; `401` `Invalid or expired refresh token` (missing row, already revoked, reused, or expired); `401` `User not found or inactive`; `401` `Device not found or revoked`; `500` generic. |
| `/api/auth/revoke` | `POST` + `Authorization: Bearer <access token>` | `{ "deviceId": string }` | `200` `{ "message": "Device revoked successfully" }` | `400` `Device ID is required`; `401` `Authorization: Bearer <token> is required.` when the header is missing; `401` invalid/expired token; scoped to the authenticated user, so another user's device is never revoked. |
| `/api/auth/health` | `GET` | none | `200` `{ "status": "healthy", "timestamp": "<ISO-8601 UTC>" }` | `405` for other methods; no Mongo or JWT dependency. |

Additional route behavior:

- `OPTIONS` on any auth route returns `204` with CORS headers and no body.
- Unknown path suffix (for example `/api/auth/unknown`) returns `404`
  `{ "error": "Not found." }`.
- Wrong method on a known route returns `405` `{ "error": "Method not allowed." }`
  with an `Allow` header.
- Malformed JSON returns `400` `{ "error": "Body must be valid JSON." }`.
- Oversized bodies return `413` with a generic error.

Error envelope for every Identity route:

```json
{ "error": "message" }
```

The React Native client reads `error` as a string
(`react_native_stash/src/auth/authenticationService.ts`). Do **not** reuse the
Kafka proxy's nested `{ "ok": false, "error": { "code", "message" } }` envelope
for auth routes. The proxy envelope and its handlers remain unchanged; the
Identity handler gets a small flat-envelope helper that reuses `jsonResponse`,
`HttpError`, `readJsonBody`, and the CORS helpers.

Contract details carried over from `Program.cs`:

- Registration validates in this order: email/password required, device ID
  required, email format, password length >= 8.
- Email is normalized with `trim()` and `toLowerCase()` before lookup and
  storage.
- `userId` in responses is the hex string of `users._id`; `deviceId` echoes the
  request.
- Revoking a device revokes the `devices` row and all `refresh_tokens` for that
  `(userId, deviceId)`. Existing access tokens are not revoked and remain valid
  until `exp`, matching the .NET service and the Kafka proxy, which does not
  consult Mongo during token verification.

## 3. JWT contract

- Algorithm: HS256 only. The signing secret is the UTF-8 bytes of
  `JWT_SIGNING_KEY`, exactly as `src/auth.ts` and .NET use it.
- Issuer and audience come from `JWT_ISSUER` and `JWT_AUDIENCE`.
- Access-token lifetime defaults to 15 minutes
  (`AUTH_ACCESS_TOKEN_EXPIRY_MINUTES`).
- Header: `{ "alg": "HS256", "typ": "JWT" }`.
- Claims to emit:

| Claim | Value |
| --- | --- |
| `nameid` | `userId` (mirrors .NET `ClaimTypes.NameIdentifier` outbound mapping) |
| `userId` | `userId` |
| `email` | normalized email |
| `deviceId` | `deviceId` |
| `device_id` | `deviceId` |
| `jti` | random UUID |
| `iat` | issued-at Unix seconds |
| `nbf` | not-before Unix seconds (same as `iat`) |
| `exp` | expiry Unix seconds |
| `iss` | `JWT_ISSUER` |
| `aud` | `JWT_AUDIENCE` |
| `sub` | `userId` (additional, safe for the proxy verifier) |

- `expiresAt` in the response body is `now + accessTokenExpiryMinutes` as an
  ISO-8601 UTC string (millisecond precision, trailing `Z`); the JWT `exp` is
  the same instant floored to Unix seconds.
- Signing is implemented in `src/identity/jwt.ts` with `node:crypto` HMAC and
  base64url encoding without padding. No external JWT package.
- Verification must accept the same token shape as the Kafka proxy. Reuse
  `verifyAccessToken` from `src/auth.ts`. Phase 1 should widen that function's
  config parameter to a narrow structural type
  (`{ jwtSigningKey, jwtIssuer, jwtAudience }`) so `AppConfig` and the Identity
  config both satisfy it without importing Kafka settings.
- The verifier already accepts `userId` or `sub`, `deviceId` or `device_id`,
  enforces HS256/issuer/audience/expiry, and allows 30 seconds of clock skew.
  Tokens minted here must pass it unchanged; tests assert this directly.
- .NET validates with zero clock skew, so do not future-date `nbf`; use the
  current time for both `iat` and `nbf`.

## 4. Password and refresh-token compatibility

Password hashing must remain byte-compatible with
`StashHost.IdentityApi/Services/PasswordHasher.cs`:

- PBKDF2 with HMAC-SHA256, exactly 100,000 iterations for new hashes.
- 16-byte random salt, 32-byte derived key.
- Format:
  `pbkdf2-sha256$<iterations>$<base64-salt>$<base64-key>`.
- Standard base64 (with `+`, `/`, and `=` padding), not base64url.
- Node implementation uses async `pbkdf2(password, salt, iterations, 32,
  'sha256', callback)` and `timingSafeEqual` for verification. Stored-hash
  parsing caps iterations at 1,000,000 and key length at 128 bytes to avoid a
  malicious-hash denial of service.
- Verification parses the iteration count from the stored hash, so legacy
  hashes with a different iteration count still verify. Malformed hashes return
  `false`, never throw.

Refresh tokens:

- Generate 64 random bytes and encode with standard base64:
  `randomBytes(64).toString('base64')`. This matches
  `Convert.ToBase64String` in .NET.
- Store the value verbatim in `refresh_tokens.token` (plaintext) for
  compatibility with the .NET service and existing rows.
- Rotation must be atomic. The .NET code does a find, then a separate revoke,
  which allows two concurrent refreshes to both succeed. The Vercel
  implementation must claim the token with one conditional update:

  ```ts
  const claimed = await refreshTokens.findOneAndUpdate(
    { token, isRevoked: false, expiresAt: { $gt: now } },
    { $set: { isRevoked: true } },
    { returnDocument: 'before' },
  );
  if (!claimed) throw new HttpError(401, 'invalid_refresh_token',
    'Invalid or expired refresh token');
  ```

  Only the request that wins this update may load the user/device and issue a
  new pair. A second concurrent refresh sees the token as revoked and gets
  `401`.
- If the user is missing/inactive or the device is missing/revoked after the
  claim, fail closed with `401`; the old token stays revoked and no new pair is
  issued.
- No Mongo transaction is required. Single-document atomicity is sufficient and
  keeps the implementation compatible with standalone MongoDB deployments.
- `POST /api/auth/revoke` sets `devices.isRevoked = true` and
  `refresh_tokens.isRevoked = true` for the authenticated `(userId, deviceId)`
  pair using `updateMany`.

## 5. MongoDB model and indexes

Documents keep the .NET camelCase conventions. `_id` values are BSON
`ObjectId`s; `userId`, `deviceId`, and `token` are strings.

`users`:

```text
{ _id: ObjectId, email: string, passwordHash: string,
  createdAt: Date, isActive: boolean }
```

`devices`:

```text
{ _id: ObjectId, userId: string, deviceId: string,
  isRevoked: boolean, createdAt: Date }
```

`refresh_tokens`:

```text
{ _id: ObjectId, userId: string, deviceId: string, token: string,
  expiresAt: Date, isRevoked: boolean, createdAt: Date }
```

`userId` is stored as the hex string of `users._id` (as .NET does). When
querying `users._id`, convert with `new ObjectId(userId)` after validating
`ObjectId.isValid(userId)`; do not pass the bare string, because the Node
driver will not implicitly coerce it without a schema. Keep `devices.userId`
and `refresh_tokens.userId` as strings.

Indexes:

| Collection | Keys | Options | Purpose |
| --- | --- | --- | --- |
| `users` | `{ email: 1 }` | unique, name `ux_users_email` | Duplicate registration guard and login lookup |
| `devices` | `{ userId: 1, deviceId: 1 }` | unique, name `ux_devices_user_device` | One row per user/device; also covers `userId` lookups |
| `refresh_tokens` | `{ token: 1 }` | unique, name `ux_refresh_tokens_token` | Refresh lookup and double-use protection |
| `devices` | `{ userId: 1 }` | name `ix_devices_user` | Device lookups by user |
| `refresh_tokens` | `{ userId: 1, deviceId: 1 }` | name `ix_refresh_tokens_user_device` | Revoke-all-for-device updates |

No TTL index is created initially: the .NET service only checks
`expiresAt` at read time, and adding a TTL would silently delete rows that the
reference implementation might still expect to see. A TTL can be added later
after both writers agree on retention.

Legacy-data risk: .NET only creates the unique `users.email` index. Existing
`devices` and `refresh_tokens` collections may contain duplicates, so creating
the new unique indexes can fail with `E11000`. Before enabling unique index
creation, run migration checks:

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

Resolve duplicates before deployment: keep the oldest active device and newest
refresh token per key, or merge manually for emails. Because index creation on a
cold start adds latency and can fail the first request, run the duplicate checks
before deployment. The Mongo store creates the indexes through a cached
`ensureIndexes()` readiness promise per warm instance and resets that promise on
failure; no separate index-migration script is included.

## 6. Serverless architecture

Implemented layout:

```text
api/auth/[...path].ts            catch-all entry; wires config + Mongo store
src/identity/config.ts           loadIdentityConfig(env); no Kafka env required
src/identity/models.ts           records and token-pair types
src/identity/store.ts            IdentityStore contract + EmailAlreadyRegisteredError
src/identity/password.ts         async PBKDF2 hash/verify + dummy hash
src/identity/jwt.ts              signAccessToken (verification reuses src/auth.ts)
src/identity/mongoStore.ts       Mongo implementation + cached connection/indexes
src/identity/service.ts          register/login/refresh/revoke logic
src/identity/handler.ts          routes, validation, flat error envelope, CORS
test/identity.test.ts            node:test contract suite (in-memory store)
```

Key decisions:

- **Catch-all route.** `api/auth/[...path].ts` default-exports a Web-signature
  handler (`fetch(request)`), matching `api/health.ts` and `api/messages.ts`.
  Derive the route from `new URL(request.url).pathname` (strip `/api/auth/`)
  rather than relying on framework-specific params, so the handler is testable
  with a plain `Request`.
- **Handler factory.** Export
  `createIdentityHandler({ config, getStore })`; `config` is the loaded Identity
  config and `getStore(config)` returns an `IdentityStore`. The default export
  wires `loadIdentityConfig(process.env)` and `getMongoIdentityStore(config)`.
  Tests inject an in-memory store and fixed config; no live Mongo is required.
- **Separate config loader.** Do not reuse `loadConfig` from `src/config.ts`
  directly: it requires Kafka variables. Add `loadIdentityConfig(env)` in
  `src/identity/config.ts`, reusing `clampInt` and `parseCorsOrigins` from
  `src/http.ts` and the same JWT variable names/defaults.
- **Route table.** `register`, `login`, `refresh`, `revoke`, `health`.
  Normalize one trailing slash, reject extra path segments with `404`.
  `OPTIONS` is handled before auth and body parsing.
- **Mongo connection cache.** Cache one store promise per `uri|database` in
  module scope for the warm instance. Options: `maxPoolSize: 5`,
  `serverSelectionTimeoutMS: 5000`, `retryWrites: true`,
  `appName: 'stash-identity-vercel'`. Connect lazily on the first auth request,
  never at module import time, and close the client if connect or index creation
  fails without caching the failure. Do not close per request.
- **CORS.** Reuse `buildCorsHeaders` / `parseCorsOrigins` and
  `CORS_ALLOWED_ORIGINS`. Return `204` for `OPTIONS`, and include CORS headers
  on error responses when an origin is allowed.
- **Body limit.** Read bodies with `readJsonBody(request,
  config.maxBodyBytes)`; default 64 KiB, clamped to 1 KiB..1 MiB. Auth payloads
  are tiny, so a small cap is preferable to the proxy's 1 MiB.
- **Secrets and errors.** Never log passwords, refresh tokens, access tokens,
  password hashes, Authorization headers, email addresses, or `MONGODB_URI`.
  Log only route, method, status, and a safe error. Never return stack traces,
  driver messages, connection strings, tokens, or hashes to clients; unexpected
  failures become `500` `{ "error": "Identity service error." }`. Missing
  configuration is logged with the env-var name server-side but returns the
  generic `500` `{ "error": "Identity API is not configured correctly." }`.
- **Vercel config.** Added
  `"api/auth/[...path].ts": { "maxDuration": 15 }` to `vercel.json`. No
  `includeFiles` entry is needed because `mongodb` is pure JavaScript and the
  Node file tracer packages it normally.
- **Dependencies.** Add `mongodb` (official Node driver, v6.x) to
  `dependencies`: `npm install mongodb`. Do not add `jsonwebtoken`, `bcrypt`, or
  `argon2`. Keep the project ESM and respect `erasableSyntaxOnly`: no TypeScript
  enums, namespaces, or constructor parameter properties.

### Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `MONGODB_URI` | Yes | — | Atlas/self-hosted connection string; secret |
| `MONGODB_DATABASE` | No | `stash` | Must be the database holding the .NET collections |
| `JWT_SIGNING_KEY` | Yes | — | Must equal the Kafka proxy and host signing key |
| `JWT_ISSUER` | No | `stash-auth` | Must match the proxy and host |
| `JWT_AUDIENCE` | No | `stash-app` | Must match the proxy and host |
| `AUTH_ACCESS_TOKEN_EXPIRY_MINUTES` | No | `15` | Clamp 1..1440 |
| `AUTH_REFRESH_TOKEN_EXPIRY_DAYS` | No | `7` | Clamp 1..365 |
| `CORS_ALLOWED_ORIGINS` | No | `*` | Comma-separated allowlist or `*` (Expo web/tools) |
| `AUTH_MAX_BODY_BYTES` | No | `65536` | Clamp 1024..1048576 |

## 7. Phases and progress tracker

| Phase | Scope | Status | Started | Completed | Verification | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 0 — Plan/contract discovery | Read .NET Identity API, models, stores, RN auth client, and proxy helpers; write this plan | **Complete** | 2026-11-21 | 2026-11-21 | Source-level review only; no code changed | Plan creation; no live service or Mongo checks |
| 1 — Core modules | `config`, `models`/`store`, async PBKDF2, JWT signing, Mongo store, cached connection/indexes | **Complete** | 2026-11-21 | 2026-11-21 | `npm run typecheck`; `npm test` (password/JWT/store-backed service) | `verifyAccessToken` widened to `JwtVerificationConfig` without changing behavior |
| 2 — HTTP handler, routes, Vercel config, dependency install | Catch-all entry, handler factory, validation, flat envelope, CORS, `vercel.json`, `mongodb` dependency | **Complete** | 2026-11-21 | 2026-11-21 | Typecheck; 13 route-level identity tests with in-memory store | Existing `/api/health` and `/api/messages` untouched; `mongodb@^6.20.0` added |
| 3 — Tests | Contract, password compatibility, token compatibility, refresh rotation, revoke scoping, CORS/404/405 | **Complete** | 2026-11-21 | 2026-11-21 | `npm test`: 37 passed, 0 failed | In-memory store mirrors the atomic refresh claim; no live Mongo |
| 4 — Documentation, RN config guidance, verification | README/plan updates, env/deploy notes, RN `EXPO_PUBLIC_IDENTITY_API_BASE_URL`, final checks | **Complete** | 2026-11-21 | 2026-11-21 | Typecheck, tests, documented manual smoke checklist | Live Vercel/Mongo/RN verification not performed |

## 8. Verification plan

Run in `Stash/kafka_proxy_vercel`:

```bash
npm install
npm run typecheck
npm test
```

Test requirements:

- **No live MongoDB.** All handler tests inject an in-memory `IdentityStore`.
  Only an optional, explicitly skipped Atlas integration test may read
  `MONGODB_URI`; it must not run in the default suite.
- **Password compatibility.** Use a fixture hash produced by the .NET
  `PasswordHasher` format and verify it in Node; assert the Node-produced hash
  matches `pbkdf2-sha256$100000$<base64>$<base64>` and verifies by recomputing
  PBKDF2. Assert wrong passwords and malformed hashes return `false`.
- **Token compatibility.** Mint tokens with `src/identity/jwt.ts`, verify them
  with the proxy's `verifyAccessToken`, and assert `userId`, `deviceId`, and
  `expiresAt`/`exp` agree. Assert wrong key, issuer, audience, algorithm, and
  expired tokens are rejected by the existing verifier.
- **Contract tests.** Exercise register (success/validation/duplicate), login
  (success/new device/revoked device/bad credentials), refresh (success,
  missing token, revoked, reused, expired), revoke (success, missing token,
  missing device, cross-user scope), and health.
- **Refresh rotation.** Assert the first refresh rotates the pair and the old
  token fails. The store claims tokens with one conditional update, so a second
  caller sees the token as revoked.
- **CORS and routing.** Assert `OPTIONS` returns `204` with the expected
  headers, disallowed origins receive no `Access-Control-Allow-Origin`, unknown
  suffixes return `404`, wrong methods return `405`, and all failures use the
  flat `{ "error": "..." }` envelope.
- **Manual smoke checklist (documented, not automated).** With real env vars,
  `GET /api/auth/health`, register a disposable account, login, refresh, use the
  new access token against `verifyAccessToken` or `POST /api/messages`, then
  revoke the device and confirm refresh fails.

### Verification log (2026-11-21)

| Command / check | Result | Notes |
| --- | --- | --- |
| `npm install mongodb@^6.20.0` | Completed | Resolved `mongodb` 6.22.0 under the `^6.20.0` range; `package-lock.json` updated. npm warned the local Node 24 does not match the project's `22.x` engine, but the install succeeded with 0 vulnerabilities. |
| `npm run typecheck` | Passed | `tsc --noEmit`, 0 errors, with the existing strict ESM/`erasableSyntaxOnly` config. |
| `npm test` | Passed | 37 tests, 37 pass, 0 fail. Includes 13 identity contract tests plus the existing auth, messages, and records suites. No live MongoDB or Kafka connection. |
| `npm run typecheck` (hardening pass) | Passed | `tsc --noEmit`, 0 errors after device-ID trimming and length guards. |
| `npm test` (hardening pass) | Passed | 39 tests, 39 pass, 0 fail; adds device-ID whitespace normalization and oversized login/refresh guard tests. No live MongoDB or Kafka connection. |
| Live Vercel deployment | Not performed | Requires project env vars and a deployment. |
| Live MongoDB/Atlas connection | Not performed | Tests inject an in-memory `IdentityStore`. |
| React Native smoke test | Not performed | Requires `EXPO_PUBLIC_IDENTITY_API_BASE_URL` and an app rebuild. |
| Legacy-field compatibility (mongoStore.ts) | `npm run typecheck` passed; `npm test` 39/39 passed | Maps missing `isActive` as `true` and missing `isRevoked` as `false`; `consumeRefreshToken` now filters `isRevoked: { $ne: true }` so legacy tokens remain single-use under the atomic `findOneAndUpdate` and expiry filter. |

Do not claim live Vercel or MongoDB testing unless it was actually performed.

## 9. Deployment and rollout

1. Implement Phases 1–3, run `npm run typecheck` and `npm test` locally.
2. In the Vercel project, set `MONGODB_URI`, `MONGODB_DATABASE`, and the JWT
   variables. `JWT_SIGNING_KEY`, `JWT_ISSUER`, and `JWT_AUDIENCE` must match the
   Kafka proxy and any host still validating tokens.
3. Run the duplicate-data checks in section 5 against the target database and fix
   any duplicates; the store's cached index bootstrap creates the indexes on the
   first auth request after deployment.
4. Deploy a preview and smoke-test `/api/auth/health`, register, login, refresh,
   revoke, CORS preflight, and error envelopes. Confirm an access token issued by
   the new function is accepted by the Kafka proxy's `verifyAccessToken`.
5. In `react_native_stash`, set
   `EXPO_PUBLIC_IDENTITY_API_BASE_URL` to the deployment origin
   (for example `https://stash-proxy.vercel.app`; no trailing slash is needed —
   `resolveUrl` joins the path). Rebuild the app because `EXPO_PUBLIC_*` values
   are inlined at build time.
6. Leave `StashHost.Functions` untouched. It is intentionally not modified, but
   it still expects the same issuer, audience, and signing key, so keep the
   shared values aligned. The .NET Identity API can stay deployed as a
   local/reference implementation during and after cutover.
7. Rollback is a configuration change: point the RN app's Identity API base URL
   back to the previous service. This plan adds only `/api/auth/*` and does not
   alter the existing proxy routes.

## 10. Risks and deferred work

- **Rate limiting.** In-memory counters in a serverless function are not
  reliable across instances. Use Vercel Firewall or Upstash/Redis for
  distributed limits. Deferred.
- **Plaintext refresh tokens.** Stored as-is for .NET/legacy compatibility.
  Hashing is a future migration and would require dual-read support during the
  transition.
- **Unique indexes over legacy duplicates.** `devices` and `refresh_tokens`
  were not uniquely indexed by .NET. Creating the new indexes can fail until
  duplicates are removed; the migration check is mandatory.
- **No access-token revocation list.** Revoking a device does not invalidate its
  already-issued access tokens before `exp`, matching .NET and the proxy. This
  is a deliberate parity decision.
- **Mixed-writer window.** During cutover, the .NET service and the Vercel
  function could both write refresh tokens. The Vercel rotation is atomic, but
  .NET's is not; keep the cutover window short and avoid running both as
  active issuers longer than necessary.
- **Clock skew.** The proxy verifier allows 30 seconds of skew while .NET uses
  zero; newly minted tokens use current time for `nbf`/`iat`, so both accept
  them.
- **Index bootstrap latency.** Creating indexes on a cold start can add latency
  or fail the first request; run the duplicate checks before deployment and
  monitor the first cold start. The readiness promise is cached per warm
  instance and reset after a failure.
- **Mongo connection storms.** Small `maxPoolSize` and bounded selection
  timeouts reduce pressure, but serverless concurrency can still exhaust Atlas
  connection limits. Monitor and raise tiers as needed.
- **No live verification here.** This environment did not run Vercel, Atlas, or
  the RN app; only local typecheck/tests and source review can be claimed.
- **Input hardening (2026-11-21).** Device IDs are trimmed before validation,
  storage, and token issuance and capped at 256 characters. Login rejects
  passwords over 1024 characters and refresh rejects tokens over 512 characters
  before any store lookup. `ensureDevice` recovers from a duplicate-key upsert
  race by re-reading the existing row, and Mongo connect/index failures log only
  the driver message server-side.
- **Deferred items not implemented in this pass:** distributed rate limiting,
  refresh-token hashing with dual-read support, a dedicated index-migration
  script, and live Atlas/Vercel/RN smoke testing.

## 11. Implementation summary

Phases 1–4 are implemented in `kafka_proxy_vercel`:

- Added `src/identity/config.ts`, `models.ts`, `store.ts`, `password.ts`,
  `jwt.ts`, `mongoStore.ts`, `service.ts`, and `handler.ts`.
- Added the catch-all `api/auth/[...path].ts` and `maxDuration: 15` in
  `vercel.json`.
- Added `mongodb@^6.20.0` to `package.json` and updated the lockfile.
- Updated `.env.example` and `README.md` with Identity/Mongo variables, routes,
  and deployment guidance.
- Added `test/identity.test.ts`; `npm run typecheck` and `npm test` pass
  locally.
- Hardening pass: trimmed device IDs across register/login/revoke, pre-store
  length guards for login passwords and refresh tokens, duplicate-key recovery in
  `ensureDevice`, and server-side logging of Mongo connection/index failures.
- Compatibility pass: `mongoStore.ts` treats legacy documents missing `isActive`/`isRevoked` as active/not revoked and still claims legacy refresh tokens exactly once.
- `StashHost.Functions` and the .NET Identity API were not modified.

No Vercel deployment, MongoDB/Atlas connection, or React Native build was
performed. Those remain manual verification steps described above.
