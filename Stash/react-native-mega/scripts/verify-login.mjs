/**
 * Exercises MegaStorage.login and tree import against a fake MEGA API. This
 * verifies the login crypto wiring (PBKDF2, master key, RSA session id), node
 * key/attribute decryption, quota parsing and session resume without network.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  Aes128,
  decryptAttributes,
  encryptAttributes,
  fileCipherKey,
  packAttributes,
  MegaStorage,
  MegaError,
} from '../dist/index.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const random = (n) => new Uint8Array(crypto.randomBytes(n));
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'user@example.com';
const USER_HANDLE = 'USERHANDLE1';
const MASTER_KEY = random(16);
const FOLDER_KEY = random(16);
const FILE_KEY = random(32);

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

function ecbEncrypt(key, data) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null).setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]));
}

function pad16(data) {
  const remainder = data.length % 16;
  return remainder === 0
    ? Buffer.from(data)
    : Buffer.concat([Buffer.from(data), Buffer.alloc(16 - remainder)]);
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
  let oldR = a;
  let r = m;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = privateKey.export({ format: 'jwk' });
const fromJwk = (value) => BigInt(`0x${Buffer.from(value, 'base64url').toString('hex')}`);
const p = fromJwk(jwk.p);
const q = fromJwk(jwk.q);
const d = fromJwk(jwk.d);
const e = fromJwk(jwk.e);
const n = p * q;
const u = modInverse(p, q);
const PRIVK_BLOB = pad16(
  Buffer.concat([toMpi(p), toMpi(q), toMpi(d), toMpi(u)]),
);
const SALT = random(16);
const SID_PLAINTEXT = random(43);
const CSID_MPI = toMpi(modPow(BigInt(`0x${Buffer.from(SID_PLAINTEXT).toString('hex')}`), e, n));

const SUBFOLDER_KEY = random(16);

function buildNodes() {
  return [
    {
      h: 'ROOT0001',
      t: 2,
      k: `${USER_HANDLE}:${b64(ecbEncrypt(MASTER_KEY, FOLDER_KEY))}`,
      a: b64(encryptAttributes({ n: 'Cloud Drive' }, FOLDER_KEY)),
    },
    {
      h: 'FILE0001',
      p: 'ROOT0001',
      t: 0,
      s: 1234,
      ts: 1700000000,
      k: `${USER_HANDLE}:${b64(ecbEncrypt(MASTER_KEY, FILE_KEY))}`,
      a: b64(encryptAttributes({ n: 'hello.txt' }, FILE_KEY)),
    },
    {
      h: 'FOLD0001',
      p: 'ROOT0001',
      t: 1,
      ts: 1700000100,
      k: `${USER_HANDLE}:${b64(ecbEncrypt(MASTER_KEY, SUBFOLDER_KEY))}`,
      a: b64(encryptAttributes({ n: 'Photos' }, SUBFOLDER_KEY)),
    },
  ];
}

function makeFetch({ requireMfa = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body ?? '[]');
    const command = body[0];
    calls.push(command);
    let result;

    switch (command.a) {
      case 'us0':
        result = { v: 2, s: b64(SALT) };
        break;
      case 'us': {
        if (requireMfa && command.mfa !== '123456') {
          result = -26;
          break;
        }
        const expectedUh = Buffer.from(
          crypto.pbkdf2Sync(PASSWORD, Buffer.from(SALT), 100000, 32, 'sha512').subarray(16),
        ).toString('base64url');
        if (command.uh !== expectedUh) {
          result = -9;
          break;
        }
        const derivedKey = new Uint8Array(
          crypto.pbkdf2Sync(PASSWORD, Buffer.from(SALT), 100000, 32, 'sha512').subarray(0, 16),
        );
        result = {
          k: b64(new Aes128(derivedKey).ecbEncrypt(MASTER_KEY)),
          csid: b64(CSID_MPI),
          privk: b64(ecbEncrypt(MASTER_KEY, PRIVK_BLOB)),
        };
        break;
      }
      case 'ug':
        result = { name: 'Test User', u: USER_HANDLE };
        break;
      case 'f':
        result = { f: buildNodes(), ok: [] };
        break;
      case 'uq':
        result = {
          utype: 'PRO',
          cstrg: 1024,
          mstrg: 1024 * 1024,
          caxfer: 10,
          mxfer: 1000,
        };
        break;
      default:
        result = {};
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => JSON.stringify([result]),
      json: async () => [result],
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify([result])).buffer,
    };
  };
  return { fetch, calls };
}

console.log('Login and tree import');
const fake = makeFetch();
let storage;

await checkAsync('login derives keys, RSA-decrypts the sid and loads the tree', async () => {
  storage = await MegaStorage.login({
    email: EMAIL,
    password: PASSWORD,
    fetch: fake.fetch,
    random,
  });

  assert.equal(storage.name, 'Test User');
  assert.equal(storage.user, USER_HANDLE);
  assert.ok(storage.root);
  assert.equal(storage.root.name, 'Cloud Drive');
  assert.equal(storage.root.children.length, 2);
});

await check('nodes decrypt names, sizes and paths', () => {
  const file = storage.find('hello.txt');
  assert.ok(file);
  assert.equal(file.id, 'FILE0001');
  assert.equal(file.size, 1234);
  assert.equal(file.path, '/Cloud Drive/hello.txt');

  const folder = storage.find('Photos');
  assert.ok(folder);
  assert.equal(folder.isFolder, true);
  assert.equal(folder.path, '/Cloud Drive/Photos');
});

await checkAsync('quota response is normalised', async () => {
  const quota = await storage.getQuota();
  assert.equal(quota.type, 'PRO');
  assert.equal(quota.spaceUsed, 1024);
  assert.equal(quota.spaceTotal, 1024 * 1024);
});

await checkAsync('session export/import resumes without the password', async () => {
  const session = storage.toJSON();
  assert.ok(session.key);
  assert.ok(session.sid);

  const resumed = await MegaStorage.fromSession(session, { fetch: fake.fetch, random });
  assert.equal(resumed.user, USER_HANDLE);
  assert.ok(resumed.find('hello.txt'));
});

console.log('Login errors');
await checkAsync('two-factor accounts return 2FA_REQUIRED, then accept the code', async () => {
  const mfa = makeFetch({ requireMfa: true });
  await assert.rejects(
    () =>
      MegaStorage.login({
        email: EMAIL,
        password: PASSWORD,
        fetch: mfa.fetch,
        random,
      }),
    (error) => error instanceof MegaError && error.code === '2FA_REQUIRED',
  );

  const storage2 = await MegaStorage.login({
    email: EMAIL,
    password: PASSWORD,
    secondFactorCode: '123456',
    fetch: mfa.fetch,
    random,
  });
  assert.ok(storage2.root);
});

await checkAsync('wrong password is rejected', async () => {
  await assert.rejects(
    () =>
      MegaStorage.login({
        email: EMAIL,
        password: 'not the password',
        fetch: fake.fetch,
        random,
      }),
    (error) => error instanceof MegaError && error.code === 'NOT_FOUND',
  );
});

console.log(`\n${checks} login/tree checks passed.`);
