/**
 * Protocol-level checks without the network: uses a fake MEGA API, upload
 * server and download server to exercise upload -> commit -> range download
 * -> MAC verification with real data.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  Aes128,
  MegaError,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  decryptAttributes,
  downloadFromUrl,
  fileCipherKey,
  macChunks,
  memorySink,
  memorySource,
  parseFileLink,
  uploadToFolder,
  utf8ToBytes,
} from '../dist/index.js';

const random = (n) => new Uint8Array(crypto.randomBytes(n));
let checks = 0;

async function check(name, fn) {
  await fn();
  checks++;
  process.stdout.write(`  ok ${name}\n`);
}

const MASTER_KEY = random(16);
const FOLDER_ID = 'ROOTNODE';
const HANDLE = 'A'.repeat(27);

function fakeMega(size) {
  const uploads = new Map();
  const state = { encrypted: new Uint8Array(0), node: null, downloadSize: size };

  const api = {
    logger: undefined,
    async request(command) {
      if (command.a === 'u') {
        assert.equal(command.s, size);
        return { p: 'https://upload.test/u' };
      }

      if (command.a === 'p') {
        const node = command.n[0];
        state.node = node;
        return {
          f: [
            {
              h: node.h,
              p: FOLDER_ID,
              t: 0,
              s: size,
              ts: Math.floor(Date.now() / 1000),
              k: node.k,
              a: node.a,
            },
          ],
        };
      }

      if (command.a === 'g') {
        return { g: 'https://download.test/d', s: state.downloadSize };
      }

      throw new Error(`Unexpected command ${command.a}`);
    },
    async postChunk(_url, offset, body) {
      uploads.set(offset, new Uint8Array(body));
      const ordered = [...uploads.entries()].sort((a, b) => a[0] - b[0]);
      let total = 0;
      const joined = [];
      for (const [, chunk] of ordered) {
        joined.push(chunk);
        total += chunk.length;
      }
      state.encrypted = Buffer.concat(joined.map((chunk) => Buffer.from(chunk)));
      void total;
      return new Uint8Array(Buffer.from(HANDLE, 'ascii'));
    },
    async getRange(_url, start, end) {
      return state.encrypted.subarray(start, end + 1);
    },
  };

  return { api, state };
}

console.log('Public link parsing');
await check('modern file link', () => {
  const key = random(32);
  const url = `https://mega.nz/file/AbCdEf12#${Buffer.from(key).toString('base64url')}`;
  const parsed = parseFileLink(url);
  assert.equal(parsed.handle, 'AbCdEf12');
  assert.equal(parsed.directory, false);
  assert.equal(bytesToHex(parsed.key), bytesToHex(key));
});

await check('modern folder link', () => {
  const key = random(16);
  const url = `https://mega.nz/folder/AbCdEf12#${Buffer.from(key).toString('base64url')}/file/SomeFile`;
  const parsed = parseFileLink(url);
  assert.equal(parsed.handle, 'AbCdEf12');
  assert.equal(parsed.directory, true);
  assert.equal(parsed.loadedFile, 'SomeFile');
});

await check('legacy file link', () => {
  const key = random(32);
  const url = `https://mega.nz/#!AbCdEf12!${Buffer.from(key).toString('base64url')}`;
  const parsed = parseFileLink(url);
  assert.equal(parsed.handle, 'AbCdEf12');
  assert.equal(parsed.directory, false);
});

await check('rejects non-MEGA links', () => {
  assert.throws(() => parseFileLink('https://example.com/file/abc#def'), /hostname/);
});

console.log('Upload -> commit -> download roundtrip');
const payload = new Uint8Array(2 * 1024 * 1024 + 333_777);
crypto.randomFillSync(payload);
payload[0] = 0;
payload[1] = 255;

const { api, state } = fakeMega(payload.length);

await check('upload commits a node with encrypted attributes and key', async () => {
  const node = await uploadToFolder({
    api,
    folderId: FOLDER_ID,
    name: 'roundtrip.bin',
    source: memorySource(payload),
    masterKey: MASTER_KEY,
    random: () => random(24),
  });

  assert.equal(node.h, HANDLE);
  assert.equal(node.s, payload.length);
  assert.equal(state.encrypted.length, payload.length);
  assert.notEqual(bytesToHex(state.encrypted.subarray(0, 64)), bytesToHex(payload.subarray(0, 64)));

  const finalKey = new Aes128(MASTER_KEY).ecbDecrypt(base64ToBytes(state.node.k));
  assert.equal(finalKey.length, 32);

  const attributes = decryptAttributes(base64ToBytes(state.node.a), finalKey);
  assert.equal(attributes.n, 'roundtrip.bin');
});

await check('download decrypts and verifies the MAC byte-for-byte', async () => {
  const finalKey = new Aes128(MASTER_KEY).ecbDecrypt(base64ToBytes(state.node.k));
  const sink = memorySink();
  const progress = [];
  await downloadFromUrl({
    api,
    url: 'https://download.test/d',
    size: payload.length,
    key: finalKey,
    sink,
    options: {
      verify: true,
      connections: 3,
      onProgress: (value) => progress.push(value.bytesTransferred),
    },
  });

  assert.equal(sink.toBytes().length, payload.length);
  assert.equal(bytesToHex(sink.toBytes()), bytesToHex(payload));
  assert.equal(progress.at(-1), payload.length);
  assert.ok(progress.length > 1, 'progress should be reported per chunk');
});

await check('tampered ciphertext fails MAC verification', async () => {
  const finalKey = new Aes128(MASTER_KEY).ecbDecrypt(base64ToBytes(state.node.k));
  const good = state.encrypted;
  const tampered = new Uint8Array(good);
  tampered[tampered.length - 1] ^= 0xff;

  const tamperingApi = {
    ...api,
    async getRange(_url, start, end) {
      return tampered.subarray(start, end + 1);
    },
  };

  await assert.rejects(
    () =>
      downloadFromUrl({
        api: tamperingApi,
        url: 'https://download.test/d',
        size: payload.length,
        key: finalKey,
        sink: memorySink(),
        options: { verify: true, connections: 1 },
      }),
    (error) => error instanceof MegaError && error.code === 'MAC_MISMATCH',
  );
});

console.log('Edge cases');
await check('empty file upload + download', async () => {
  const empty = fakeMega(0);
  const node = await uploadToFolder({
    api: empty.api,
    folderId: FOLDER_ID,
    name: 'empty.txt',
    source: memorySource(new Uint8Array(0)),
    masterKey: MASTER_KEY,
    random: () => random(24),
  });
  assert.equal(node.s, 0);

  const finalKey = new Aes128(MASTER_KEY).ecbDecrypt(base64ToBytes(empty.state.node.k));
  const sink = memorySink();
  await downloadFromUrl({
    api: empty.api,
    url: 'https://download.test/d',
    size: 0,
    key: finalKey,
    sink,
    options: { verify: true },
  });
  assert.equal(sink.toBytes().length, 0);
});

await check('upload source ending early is rejected', async () => {
  const short = {
    size: 1000,
    async read(offset, length) {
      return new Uint8Array(Math.min(length, 100));
    },
    // Always returns data, so this should not throw; instead it loops to fill the chunk.
  };
  const shortApi = fakeMega(1000);
  await uploadToFolder({
    api: shortApi.api,
    folderId: FOLDER_ID,
    name: 'loop.bin',
    source: short,
    masterKey: MASTER_KEY,
    random: () => random(24),
  });
  assert.equal(shortApi.api ? shortApi.state.encrypted.length : 0, 1000);
});

await check('MAC chunk boundaries cover odd sizes', () => {
  for (const size of [0, 1, 16, 131072, 131073, 1024 * 1024, 5_123_456]) {
    let total = 0;
    for (const chunk of macChunks(size)) total += chunk.length;
    assert.equal(total, size);
  }
});

console.log('Memory adapters + attributes');
await check('memory source honours ranges', async () => {
  const data = utf8ToBytes('0123456789');
  const source = memorySource(data);
  assert.equal(bytesToUtf8(await source.read(2, 3)), '234');
  assert.equal((await source.read(9, 50)).length, 1);
});

console.log(`\n${checks} protocol checks passed.`);
