# react-native-mega

A mobile-first implementation of the MEGA client protocol for React Native, Expo,
and Node — **no native modules, no `Buffer`, no Node streams**.

It is a port of the parts of [`megajs`](https://github.com/qgustavor/mega) that
mobile apps actually need, built around explicit chunked transfers instead of
Node stream pipelines.

## Why a port instead of a polyfill?

Hermes has no Node `crypto` and no `crypto.subtle`; React Native's `fetch` cannot
stream request bodies, and the bundled `megajs` browser build relies on
`Buffer`, `readable-stream`, `pumpify` and 500 KB of stream machinery. This
package implements the protocol directly with:

- `@noble/ciphers` + `@noble/hashes` (pure JS, audited, Hermes-safe)
- ranged HTTP GETs for downloads and one chunk at a time for uploads
- app-supplied file `ByteSource` / `ByteSink`, so the SDK never touches a
  platform filesystem API
- BigInt RSA for login (no native crypto, works in Expo Go)

## Features

- Login for MEGA v1 and v2 accounts, optional two-factor code, session resume
- Full Drive tree with decrypted names, sizes, timestamps and paths
- Chunked downloads with AES-CTR decryption and per-chunk + meta-MAC verification
- Chunked uploads with progress, cancellation, and protocol-aligned chunk sizes
- Folder create, rename, move, delete (trash or permanent)
- File links, public file downloads, and public folder listing/downloads
- Quota readout
- Progress callbacks and `AbortSignal` support on transfers
- No native dependencies → runs in Expo Go

## Install

```bash
npm install react-native-mega
# or, inside this repository:
cd react-native-mega && npm install && npm run build
```

The package ships compiled `dist/` JavaScript and TypeScript declarations.
Run `npm run build` after changing `src/`.

## Quick start

```ts
import { MegaStorage } from 'react-native-mega';

const storage = await MegaStorage.login({
  email: 'user@example.com',
  password: '…',
  // fetch defaults to globalThis.fetch
});

console.log(storage.root?.name);            // Cloud Drive
console.log(storage.find('photo.jpg'));     // deep search

await storage.root!.upload('hello.txt', {
  size: 11,
  read: async (offset, length) => new TextEncoder().encode('hello world').subarray(offset, offset + length),
}).then((file) => console.log('uploaded', file.name));
```

### Streaming files on Expo

```ts
import { File, FileMode, Paths } from 'expo-file-system';
import * as ExpoCrypto from 'expo-crypto';
import { MegaStorage, type ByteSink } from 'react-native-mega';

const random = (n: number) => ExpoCrypto.getRandomBytes(n);

const storage = await MegaStorage.login({
  email,
  password,
  random,
  // Native SHA-256 makes MEGA's login proof-of-work fast.
  hashcashDigest: async (data) =>
    new Uint8Array(await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data)),
});

// Upload without loading the file into memory.
const picked = new File(uri);
const handle = picked.open(FileMode.ReadOnly);
await storage.root!.upload(picked.name, {
  size: picked.size,
  async read(offset, length) {
    handle.offset = offset;
    return handle.readBytes(length);
  },
  close: () => handle.close(),
});

// Download into a cache file.
const target = new File(Paths.cache, 'download.bin');
target.create();
const writeHandle = target.open(FileMode.WriteOnly);
const sink: ByteSink = {
  write: (chunk) => writeHandle.writeBytes(chunk),
  close: () => writeHandle.close(),
  abort: () => target.delete(),
};
await storage.find('download.bin')!.downloadTo(sink);
```

### Public links

```ts
import { MegaPublicFile, MegaPublicFolder } from 'react-native-mega';

const file = MegaPublicFile.fromURL('https://mega.nz/file/…', { fetch });
await file.load();
await file.downloadTo(sink);

const folder = MegaPublicFolder.fromURL('https://mega.nz/folder/…', { fetch });
await folder.load();
console.log(folder.root?.children.map((entry) => entry.name));
```

### Sessions

```ts
const saved = storage.toJSON();                 // { key, sid, name, user }
const resumed = await MegaStorage.fromSession(saved);
```

Store the session in secure storage; the master key in it grants account access.

### Hashcash (login proof of work)

MEGA answers some API calls with an `X-Hashcash` challenge, mostly for password
logins from unfamiliar networks. The SDK solves it automatically. Each candidate
hashes `counter (4 bytes) || token × 262144` = **12.58 MB**, and the challenge's
`easiness` accepts roughly `2^32 / threshold` candidates, so a typical
`1:192:…` challenge needs ~256 hashes — about **3.2 GB of SHA-256**, seconds on a
phone and longer when the digest is pure JS.

There is no algorithmic shortcut: the counter sits in the first block, so every
candidate invalidates the entire hash and no state can be reused. The useful
levers are:

- **Avoid it.** Only a password login is challenged; `MegaStorage.fromSession`
  reuses a stored session and skips the proof of work entirely.
- **Use a native digest** (`hashcashDigest`) instead of the pure-JS default.
- **`hashcashConcurrency`** searches several candidates at once. It only pays off
  where the digest is asynchronous (web `crypto.subtle`, Node's thread pool);
  `expo-crypto`'s native `digest` is synchronous `MessageDigest` on the JS thread,
  where extra lanes just cost another 12.58 MB each.

`hashcashProgress` reports attempts and elapsed time while the solve runs, and the
solve honours the request's `AbortSignal`.

## API overview

| Export | Purpose |
|---|---|
| `MegaStorage.login(options)` | Authenticate and load the tree |
| `MegaStorage.fromSession(session)` | Resume without a password |
| `storage.root / trash / inbox` | Tree roots (`MegaNode`) |
| `storage.find(query)`, `storage.filter(query)` | Deep search |
| `storage.getQuota()` | Storage and transfer quota |
| `node.upload(name, source, options)` | Upload from a `ByteSource` |
| `node.downloadTo(sink, options)` | Verified chunked download |
| `node.mkdir`, `rename`, `moveTo`, `delete`, `link` | Mutations |
| `MegaPublicFile` / `MegaPublicFolder` | Public links without an account |
| `parseFileLink(url)` | Link parser |
| `MegaError` | Typed errors (`MAC_MISMATCH`, `BANDWIDTH_LIMIT`, `2FA_REQUIRED`, …) |

`TransferOptions`: `{ signal, onProgress, connections, retries, verify }`.

### Adapters

| Option | Default | Notes |
|---|---|---|
| `fetch` | `globalThis.fetch` | Expo SDK 56+ uses `expo/fetch`, which streams responses |
| `random` | `crypto.getRandomValues` | Pass `expo-crypto.getRandomBytes` in Hermes |
| `hashcashDigest` | pure-JS SHA-256 | Inject a native digest; pure JS hashes 12.58 MB per attempt |
| `hashcashSolver` | — | Fully custom solver |
| `hashcashConcurrency` | `1` | Parallel candidate searches; only helps with an asynchronous digest |
| `hashcashProgress` | — | `({ attempts, elapsedMs })` while a challenge is being solved |
| `logger` | none | `{ debug, warn, error }` |

## Protocol notes

- File keys are 32 bytes: AES key, 64-bit nonce, 64-bit meta-MAC.
- Data is AES-128-CTR with the counter `nonce || blockIndex`.
- Chunk MACs are CBC-MAC with `nonce || nonce` as the IV, reset at
  `128K, 384K, 768K, 1280K, 1920K, 2688K, 3584K, 4608K, then 1 MB`.
- The condensed meta-MAC is XOR/AES-ECB chained and folded to 8 bytes.
- Uploads POST ciphertext to `<uploadUrl>/<offset>`; the completion handle is
  committed with the `p` command.
- All keys and attributes sent to the API use URL-safe base64.

## Limitations

- Creating **folder links** requires MEGA's user-to-user share-key exchange
  (`s2` + crypto request matrix) and is not implemented; file links work.
- No contacts/chat, file revisions, thumbnails, or media streaming.
- Transfers are chunked but sequential per file (bounded memory, one chunk in
  flight); `connections` only affects download prefetch.
- The SDK does not persist sessions or files; the app owns storage.
- MEGA's terms of service apply to any account you use.

## Verification

No test framework is used. Plain Node scripts cross-check the implementation:

```bash
npm run build
node scripts/verify-crypto.mjs     # AES/CTR/MAC/PBKDF2/RSA vs node:crypto
node scripts/verify-protocol.mjs   # upload → commit → download with a fake API
node scripts/verify-login.mjs      # login + RSA sid + tree + session, fake API
npm run typecheck
```

`npm run verify` runs the build and all three scripts.

The `react_native_mega_demo/` app exercises the SDK on a device. See its README.
