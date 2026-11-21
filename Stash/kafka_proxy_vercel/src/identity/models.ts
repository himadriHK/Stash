/** Identity records and token-pair shapes shared by the store, service, and tests. */

export interface IdentityUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  isActive: boolean;
}

export interface IdentityDevice {
  id: string;
  userId: string;
  deviceId: string;
  isRevoked: boolean;
  createdAt: Date;
}

export interface IdentityRefreshToken {
  id: string;
  userId: string;
  deviceId: string;
  token: string;
  expiresAt: Date;
  isRevoked: boolean;
  createdAt: Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  deviceId: string;
}
