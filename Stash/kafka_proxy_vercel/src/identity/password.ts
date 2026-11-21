/**
 * PBKDF2-SHA256 password hashing, byte-compatible with
 * StashHost.IdentityApi/Services/PasswordHasher.cs.
 *
 * Format: pbkdf2-sha256$<iterations>$<base64-salt>$<base64-key>
 */
import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'pbkdf2-sha256';
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_ITERATIONS = 1_000_000;
const MAX_KEY_BYTES = 128;

function derive(
  password: string,
  salt: Buffer,
  iterations: number,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, keyLength, 'sha256', (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function decodeBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 0 ? null : decoded;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, ITERATIONS, KEY_BYTES);
  return `${PREFIX}$${ITERATIONS}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) {
    return false;
  }

  const parts = hash.split('$');
  if (parts.length !== 4) {
    return false;
  }
  const [prefix, iterationsRaw, saltRaw, keyRaw] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (prefix !== PREFIX || !/^\d+$/.test(iterationsRaw)) {
    return false;
  }

  const iterations = Number(iterationsRaw);
  if (iterations < 1 || iterations > MAX_ITERATIONS) {
    return false;
  }

  const salt = decodeBase64(saltRaw);
  const expectedKey = decodeBase64(keyRaw);
  if (!salt || !expectedKey || expectedKey.length > MAX_KEY_BYTES) {
    return false;
  }

  try {
    const actualKey = await derive(password, salt, iterations, expectedKey.length);
    if (actualKey.length !== expectedKey.length) {
      return false;
    }
    return timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}

/**
 * Valid PBKDF2-SHA256 fixture used when a login email is unknown, so the
 * password-verification cost does not reveal whether an account exists.
 */
export const DUMMY_PASSWORD_HASH =
  'pbkdf2-sha256$100000$kc9bHnKyPGZty4rVWaHqsg==$PsVxIGDuDa5NHAppCLa8byq/fX2SC8hiuXTqb2/6JJM=';
