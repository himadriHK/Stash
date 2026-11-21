/** Persistence contract for the Identity API plus its typed store error. */
import type {
  IdentityDevice,
  IdentityRefreshToken,
  IdentityUser,
} from './models.ts';

/** Thrown when a unique email index rejects a duplicate registration. */
export class EmailAlreadyRegisteredError extends Error {
  constructor(message = 'A user with this email already exists') {
    super(message);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export interface IdentityStore {
  ensureIndexes(): Promise<void>;
  findUserByEmail(email: string): Promise<IdentityUser | null>;
  findUserById(userId: string): Promise<IdentityUser | null>;
  createUser(email: string, passwordHash: string): Promise<IdentityUser>;
  findDevice(userId: string, deviceId: string): Promise<IdentityDevice | null>;
  ensureDevice(userId: string, deviceId: string): Promise<IdentityDevice>;
  revokeDevice(userId: string, deviceId: string): Promise<void>;
  /**
   * Atomically claims a refresh token: checks it is not revoked and is not
   * expired, marks it revoked, and returns the pre-update record. Exactly one
   * concurrent caller wins.
   */
  consumeRefreshToken(token: string, now: Date): Promise<IdentityRefreshToken | null>;
  createRefreshToken(
    userId: string,
    deviceId: string,
    token: string,
    expiresAt: Date,
  ): Promise<IdentityRefreshToken>;
}
