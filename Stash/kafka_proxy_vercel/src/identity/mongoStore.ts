/** MongoDB-backed IdentityStore with a per-process connection cache. */
import { MongoClient, MongoServerError, ObjectId, type Collection, type Db } from 'mongodb';

import type {
  IdentityDevice,
  IdentityRefreshToken,
  IdentityUser,
} from './models.ts';
import { EmailAlreadyRegisteredError, type IdentityStore } from './store.ts';

interface UserDocument {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
  isActive: boolean;
}

interface DeviceDocument {
  _id: ObjectId;
  userId: string;
  deviceId: string;
  isRevoked: boolean;
  createdAt: Date;
}

interface RefreshTokenDocument {
  _id: ObjectId;
  userId: string;
  deviceId: string;
  token: string;
  expiresAt: Date;
  isRevoked: boolean;
  createdAt: Date;
}

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function mapUser(document: UserDocument): IdentityUser {
  return {
    id: document._id.toHexString(),
    email: document.email,
    passwordHash: document.passwordHash,
    createdAt: document.createdAt,
    isActive: document.isActive !== false,
  };
}

function mapDevice(document: DeviceDocument): IdentityDevice {
  return {
    id: document._id.toHexString(),
    userId: document.userId,
    deviceId: document.deviceId,
    isRevoked: document.isRevoked === true,
    createdAt: document.createdAt,
  };
}

function mapRefreshToken(document: RefreshTokenDocument): IdentityRefreshToken {
  return {
    id: document._id.toHexString(),
    userId: document.userId,
    deviceId: document.deviceId,
    token: document.token,
    expiresAt: document.expiresAt,
    isRevoked: document.isRevoked === true,
    createdAt: document.createdAt,
  };
}

export class MongoIdentityStore implements IdentityStore {
  private readonly users: Collection<UserDocument>;
  private readonly devices: Collection<DeviceDocument>;
  private readonly refreshTokens: Collection<RefreshTokenDocument>;
  private readiness: Promise<void> | null = null;

  constructor(database: Db) {
    this.users = database.collection<UserDocument>('users');
    this.devices = database.collection<DeviceDocument>('devices');
    this.refreshTokens = database.collection<RefreshTokenDocument>('refresh_tokens');
  }

  ensureIndexes(): Promise<void> {
    if (!this.readiness) {
      this.readiness = this.createIndexes().catch((error: unknown) => {
        this.readiness = null;
        throw error;
      });
    }
    return this.readiness;
  }

  private async createIndexes(): Promise<void> {
    await this.users.createIndex(
      { email: 1 },
      { unique: true, name: 'ux_users_email' },
    );
    await this.devices.createIndex(
      { userId: 1, deviceId: 1 },
      { unique: true, name: 'ux_devices_user_device' },
    );
    await this.devices.createIndex({ userId: 1 }, { name: 'ix_devices_user' });
    await this.refreshTokens.createIndex(
      { token: 1 },
      { unique: true, name: 'ux_refresh_tokens_token' },
    );
    await this.refreshTokens.createIndex(
      { userId: 1, deviceId: 1 },
      { name: 'ix_refresh_tokens_user_device' },
    );
  }

  async findUserByEmail(email: string): Promise<IdentityUser | null> {
    const document = await this.users.findOne({ email });
    return document ? mapUser(document) : null;
  }

  async findUserById(userId: string): Promise<IdentityUser | null> {
    if (!OBJECT_ID_PATTERN.test(userId)) {
      return null;
    }
    const document = await this.users.findOne({ _id: new ObjectId(userId) });
    return document ? mapUser(document) : null;
  }

  async createUser(email: string, passwordHash: string): Promise<IdentityUser> {
    const document: UserDocument = {
      _id: new ObjectId(),
      email,
      passwordHash,
      createdAt: new Date(),
      isActive: true,
    };

    try {
      await this.users.insertOne(document);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }

    return mapUser(document);
  }

  async findDevice(userId: string, deviceId: string): Promise<IdentityDevice | null> {
    const document = await this.devices.findOne({ userId, deviceId });
    return document ? mapDevice(document) : null;
  }

  async ensureDevice(userId: string, deviceId: string): Promise<IdentityDevice> {
    try {
      const document = await this.devices.findOneAndUpdate(
        { userId, deviceId },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            userId,
            deviceId,
            isRevoked: false,
            createdAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after' },
      );

      if (!document) {
        throw new Error('Failed to ensure the device record.');
      }
      return mapDevice(document);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const document = await this.devices.findOne({ userId, deviceId });
        if (document) {
          return mapDevice(document);
        }
      }
      throw error;
    }
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    await this.devices.updateMany({ userId, deviceId }, { $set: { isRevoked: true } });
    await this.refreshTokens.updateMany(
      { userId, deviceId },
      { $set: { isRevoked: true } },
    );
  }

  async consumeRefreshToken(
    token: string,
    now: Date,
  ): Promise<IdentityRefreshToken | null> {
    const document = await this.refreshTokens.findOneAndUpdate(
      { token, isRevoked: { $ne: true }, expiresAt: { $gt: now } },
      { $set: { isRevoked: true } },
      { returnDocument: 'before' },
    );
    return document ? mapRefreshToken(document) : null;
  }

  async createRefreshToken(
    userId: string,
    deviceId: string,
    token: string,
    expiresAt: Date,
  ): Promise<IdentityRefreshToken> {
    const document: RefreshTokenDocument = {
      _id: new ObjectId(),
      userId,
      deviceId,
      token,
      expiresAt,
      isRevoked: false,
      createdAt: new Date(),
    };
    await this.refreshTokens.insertOne(document);
    return mapRefreshToken(document);
  }
}

export interface MongoIdentityStoreConfig {
  mongoUri: string;
  mongoDatabase: string;
}

const storeCache = new Map<string, Promise<MongoIdentityStore>>();

async function connect(config: MongoIdentityStoreConfig): Promise<MongoIdentityStore> {
  const client = new MongoClient(config.mongoUri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5_000,
    retryWrites: true,
    appName: 'stash-identity-vercel',
  });

  try {
    await client.connect();
    const store = new MongoIdentityStore(client.db(config.mongoDatabase));
    await store.ensureIndexes();
    return store;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[identity] MongoDB connection/index setup failed:', message);
    await client.close().catch(() => undefined);
    throw new Error('Identity database is unavailable.');
  }
}

export function getMongoIdentityStore(
  config: MongoIdentityStoreConfig,
): Promise<MongoIdentityStore> {
  const key = `${config.mongoUri}|${config.mongoDatabase}`;
  const cached = storeCache.get(key);
  if (cached) {
    return cached;
  }

  const pending = connect(config);
  storeCache.set(key, pending);
  pending.catch(() => {
    if (storeCache.get(key) === pending) {
      storeCache.delete(key);
    }
  });
  return pending;
}
