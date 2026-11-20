/**
 * Cross-checks the pure-JS MEGA crypto against Node's native crypto module.
 * Run with `node scripts/verify-crypto.mjs` after `npm run build`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  Aes128,
  chunkMac,
  condenseMacs,
  ctrCounterForOffset,
  decodePrivateKey,
  encryptAttributes,
  decryptAttributes,
  fileCipherKey,
  fileMetaMac,
  fileNonce,
  incrementCounterBlock,
  macChunks,
  mergeKeyMac,
  packAttributes,
  prepareKeyV2,
  rsaDecryptMpi,
  hashcashThreshold,
  solveHashcash,
  stringHash,
  unmergeKeyMac,
  unpackAttributes,
} from '../dist/index.js';

const random = (n) => new Uint8Array(crypto.randomBytes(n));
const hex = (bytes) => Buffer.from(bytes).toString('hex');

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  process.stdout.write(`  ok ${name}\n`);
}
async function checkAsync(name, fn) {
  await fn();
  checks++;
  process.stdout.write(`  ok ${name}\n`);
}

function nodeEcb(key, data, decrypt = false) {
  const cipher = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)(
    'aes-128-ecb',
    Buffer.from(key),
    null,
  ).setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
}

function nodeCbc(key, iv, data) {
  const cipher = crypto
    .createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv))
    .setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
}

function pad16(data) {
  const remainder = data.length % 16;
  if (remainder === 0) return Buffer.from(data);
  return Buffer.concat([Buffer.from(data), Buffer.alloc(16 - remainder)]);
}

function refChunkMac(key, nonce, plaintext) {
  const iv = Buffer.concat([Buffer.from(nonce.subarray(0, 8)), Buffer.from(nonce.subarray(0, 8))]);
  const padded = pad16(plaintext);
  if (padded.length === 0) return new Uint8Array(iv);
  const cipher = crypto
    .createCipheriv('aes-128-cbc', Buffer.from(key), iv)
    .setAutoPadding(false);
  const out = Buffer.concat([cipher.update(padded), cipher.final()]);
  return new Uint8Array(out.subarray(out.length - 16));
}

function refCondense(key, macs) {
  const cipher = crypto
    .createCipheriv('aes-128-ecb', Buffer.from(key), null)
    .setAutoPadding(false);
  let mac = Buffer.alloc(16);
  for (const item of macs) {
    const xored = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) xored[i] = mac[i] ^ item[i];
    mac = cipher.update(xored);
  }
  return Buffer.from([
    mac[0] ^ mac[4],
    mac[1] ^ mac[5],
    mac[2] ^ mac[6],
    mac[3] ^ mac[7],
    mac[8] ^ mac[12],
    mac[9] ^ mac[13],
    mac[10] ^ mac[14],
    mac[11] ^ mac[15],
  ]);
}

function refStringHash(key, data) {
  const h32 = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    const remaining = data.length - i;
    let value = 0;
    if (remaining < 4) {
      for (let j = 0; j < remaining; j++) value = (value << 8) | data[i + j];
      value <<= (4 - remaining) * 8;
    } else {
      value =
        (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    }
    h32[(i / 4) & 3] = (h32[(i / 4) & 3] ^ value) >>> 0;
  }

  const state = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) state.writeUInt32BE(h32[i] >>> 0, i * 4);
  const cipher = crypto
    .createCipheriv('aes-128-ecb', Buffer.from(key), null)
    .setAutoPadding(false);
  let hash = state;
  for (let i = 0; i < 16384; i++) hash = cipher.update(hash);
  return Buffer.concat([hash.subarray(0, 4), hash.subarray(8, 12)]);
}

function toMpi(value) {
  const bytes = [];
  let current = value;
  while (current > 0n) {
    bytes.unshift(Number(current & 0xffn));
    current >>= 8n;
  }
  const body = bytes.length === 0 ? [0] : bytes;
  const bits = value === 0n ? 0 : value.toString(2).length;
  return Buffer.from([(bits >> 8) & 0xff, bits & 0xff, ...body]);
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let value = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

function modInverse(a, m) {
  let old_r = a;
  let r = m;
  let old_s = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

console.log('AES primitives vs node:crypto');
check('AES-128-ECB encrypt/decrypt', () => {
  for (const length of [16, 32, 64, 160]) {
    const key = random(16);
    const data = random(length);
    const expected = nodeEcb(key, data);
    assert.equal(hex(new Aes128(key).ecbEncrypt(data)), hex(expected));
    assert.equal(hex(new Aes128(key).ecbDecrypt(expected)), hex(data));
  }
});

check('AES-128-CBC zero IV encrypt/decrypt', () => {
  for (const length of [16, 48, 160]) {
    const key = random(16);
    const data = random(length);
    const iv = new Uint8Array(16);
    const expected = nodeCbc(key, iv, data);
    assert.equal(hex(new Aes128(key).cbcEncrypt(data)), hex(expected));
    assert.equal(hex(new Aes128(key).cbcDecrypt(expected)), hex(data));
  }
});

check('AES-128-CTR at a counter offset', () => {
  const key = random(16);
  const nonce = random(8);
  const offset = 3 * 128 * 1024; // 16-aligned, past two MAC chunks
  const data = random(1000);
  const counter = ctrCounterForOffset(nonce, offset);
  const expectedCounter = incrementCounterBlock(
    Buffer.concat([Buffer.from(nonce), Buffer.alloc(8)]),
    offset / 16,
  );
  assert.equal(hex(counter), hex(expectedCounter));

  const cipher = crypto.createCipheriv(
    'aes-128-ctr',
    Buffer.from(key),
    Buffer.from(expectedCounter),
  );
  const expected = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  assert.equal(hex(new Aes128(key).ctrXor(data, counter)), hex(expected));
  // CTR is symmetric.
  assert.equal(hex(new Aes128(key).ctrXor(expected, counter)), hex(data));
});

console.log('MEGA key derivation');
check('PBKDF2-SHA512 v2 derivation', () => {
  const password = Buffer.from('correct horse battery staple');
  const salt = random(16);
  const ours = prepareKeyV2(new Uint8Array(password), salt, 100000);
  const expected = crypto.pbkdf2Sync(password, Buffer.from(salt), 100000, 32, 'sha512');
  assert.equal(hex(ours), hex(expected));
});

check('MEGA v1 string hash', () => {
  const key = random(16);
  for (const input of ['user@example.com', 'a', 'a'.repeat(33), 'héllo']) {
    const bytes = new Uint8Array(Buffer.from(input, 'utf8'));
    assert.equal(hex(stringHash(key, bytes)), hex(refStringHash(key, bytes)));
  }
});

check('file key merge/unmerge roundtrip', () => {
  const key24 = random(24);
  const mac = random(8);
  const merged = mergeKeyMac(key24, mac);

  assert.equal(hex(unmergeKeyMac(merged)), hex(key24));
  assert.equal(hex(fileCipherKey(merged)), hex(key24.subarray(0, 16)));
  assert.equal(hex(fileNonce(merged)), hex(key24.subarray(16, 24)));
  assert.equal(hex(fileMetaMac(merged)), hex(mac));
});

console.log('Chunk MAC + condensation');
check('MAC chunk boundaries match the protocol', () => {
  const offsets = [...macChunks(6_000_000)].map((chunk) => chunk.offset);
  assert.deepEqual(offsets, [
    0, 131072, 393216, 786432, 1310720, 1966080, 2752512, 3670016, 4718592, 5767168,
  ]);

  let total = 0;
  for (const chunk of macChunks(6_000_000)) {
    assert.equal(chunk.offset, total);
    total += chunk.length;
  }
  assert.equal(total, 6_000_000);
});

check('chunk MAC (CBC) matches the reference for aligned/partial data', () => {
  const key = random(16);
  const nonce = random(8);
  for (const length of [0, 1, 15, 16, 17, 128 * 1024, 300_000]) {
    const data = random(length);
    assert.equal(hex(chunkMac(key, nonce, data)), hex(refChunkMac(key, nonce, data)));
  }
});

check('condensed meta-MAC matches the reference', () => {
  const key = random(16);
  const macs = Array.from({ length: 9 }, () => random(16));
  assert.equal(hex(condenseMacs(key, macs)), hex(refCondense(key, macs)));
});

check('empty file MAC is the initial nonce block', () => {
  const key = random(16);
  const nonce = random(8);
  const expected = new Uint8Array([...nonce, ...nonce]);
  assert.equal(hex(chunkMac(key, nonce, new Uint8Array(0))), hex(expected));
});

console.log('Attributes');
check('attribute pack/encrypt/decrypt roundtrip', () => {
  const key = random(32);
  const attributes = { n: 'héllo 🎉 world.txt', lbl: 2, fav: 1 };
  const packed = packAttributes(attributes);
  assert.equal(packed.length % 16, 0);
  assert.deepEqual(unpackAttributes(packed), attributes);

  const encrypted = encryptAttributes(attributes, key);
  assert.deepEqual(decryptAttributes(encrypted, key), attributes);

  const folderKey = random(16);
  const folderEncrypted = encryptAttributes({ n: 'folder' }, folderKey);
  assert.deepEqual(decryptAttributes(folderEncrypted, folderKey), { n: 'folder' });
});

console.log('RSA login support');
check('MPI private-key decode + raw RSA decryption', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = privateKey.export({ format: 'jwk' });
  // JWK numbers are base64url, not hex.
  const fromJwk = (value) => BigInt(`0x${Buffer.from(value, 'base64url').toString('hex')}`);
  const p = fromJwk(jwk.p);
  const q = fromJwk(jwk.q);
  const d = fromJwk(jwk.d);
  const n = p * q;
  const e = fromJwk(jwk.e);
  const u = modInverse(p, q);

  const blob = new Uint8Array(
    Buffer.concat([toMpi(p), toMpi(q), toMpi(d), toMpi(u)]),
  );
  const decoded = decodePrivateKey(blob);
  assert.equal(decoded.n, n);

  // A 27-character handle-style plaintext, encrypted with the public exponent.
  const message = BigInt(`0x${crypto.randomBytes(19).toString('hex')}`);
  const ciphertext = modPow(message, e, n);
  const plaintextBytes = Buffer.from(message.toString(16).padStart(38, '0'), 'hex');

  const decrypted = rsaDecryptMpi(new Uint8Array(toMpi(ciphertext)), decoded);
  assert.equal(hex(decrypted), hex(plaintextBytes));
  assert.ok(publicKey.asymmetricKeyType === 'rsa');
});

console.log('Hashcash');
await checkAsync('hashcash threshold matches the reference easiness values', async () => {
  // mantissa = ((easiness & 63) << 1) + 1, shift = (easiness >> 6) * 7 + 3.
  assert.equal(hashcashThreshold(160), (65 << 17) >>> 0);
  assert.equal(hashcashThreshold(192), 1 << 24);
  assert.equal(hashcashThreshold(200), (17 << 24) >>> 0);
  assert.equal(hashcashThreshold(224), (65 << 24) >>> 0);
});

await checkAsync('hashcash concurrency searches disjoint counters and solves', async () => {
  let attempts = 0;
  const digest = () => {
    attempts += 1;
    const hash = new Uint8Array(32);
    // Fail the first nine candidates, then pass.
    if (attempts <= 9) hash.fill(0xff, 0, 4);
    return hash;
  };
  const token = await solveHashcash('1:10::AAAA', digest, { concurrency: 3 });
  assert.equal(token.split(':')[0], '1');
  assert.equal(token.split(':')[1], 'AAAA');
  // The tenth candidate passes; lanes already in flight may add a few more.
  assert.ok(attempts >= 10, `expected at least 10 candidates, got ${attempts}`);
});

await checkAsync('hashcash returns a well-formed token', async () => {
  const token = await solveHashcash('1:10::AAAA', async () => new Uint8Array(32));
  assert.match(token, /^1:AAAA:[A-Za-z0-9_-]{6}$/);
});

console.log(`\n${checks} crypto checks passed.`);
