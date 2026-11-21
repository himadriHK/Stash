import { afterAll, describe, expect, it } from 'vitest';

import {
  JwtError,
  readHeaderValue,
  verifyAuthorizationHeader,
  verifyToken,
} from '../../src/auth/jwt';
import {
  OTHER_SIGNING_KEY,
  createWorkspace,
  signToken,
} from '../helpers/env';

const workspace = createWorkspace();

afterAll(() => workspace.cleanup());

async function expectJwtError(promise: Promise<unknown>, code: JwtError['code']): Promise<JwtError> {
  try {
    await promise;
    throw new Error('Expected JwtError');
  } catch (error) {
    expect(error).toBeInstanceOf(JwtError);
    const jwtError = error as JwtError;
    expect(jwtError.code).toBe(code);
    return jwtError;
  }
}

describe('JWT identity extraction', () => {
  it('reads userId from userId, nameid, sub and ClaimTypes.NameIdentifier', async () => {
    const claims = [
      { userId: 'user-a' },
      { nameid: 'user-b' },
      { sub: 'user-c' },
      { 'ClaimTypes.NameIdentifier': 'user-d' },
    ];
    for (const claim of claims) {
      const token = await signToken(workspace.env, { userId: undefined, ...claim });
      const identity = await verifyAuthorizationHeader(
        { authorization: `Bearer ${token}` },
        workspace.env,
      );
      expect(identity.userId).toBe(Object.values(claim)[0]);
      expect(identity.deviceId).toBe('device-1');
    }
  });

  it('reads deviceId from deviceId and device_id', async () => {
    const tokenA = await signToken(workspace.env, { deviceId: 'device-a' });
    const tokenB = await signToken(workspace.env, { deviceId: undefined, device_id: 'device-b' });

    expect(
      (await verifyAuthorizationHeader({ authorization: tokenA }, workspace.env)).deviceId,
    ).toBe('device-a');
    expect(
      (await verifyAuthorizationHeader({ Authorization: tokenB }, workspace.env)).deviceId,
    ).toBe('device-b');
  });

  it('accepts case-insensitive headers, Buffers, arrays and bare tokens', async () => {
    const token = await signToken(workspace.env);

    await expect(
      verifyAuthorizationHeader({ AUTHORIZATION: `bearer ${token}` }, workspace.env),
    ).resolves.toMatchObject({ userId: 'user-1' });
    await expect(
      verifyAuthorizationHeader(
        { authorization: Buffer.from(`Bearer ${token}`, 'utf8') },
        workspace.env,
      ),
    ).resolves.toMatchObject({ userId: 'user-1' });
    await expect(
      verifyAuthorizationHeader({ authorization: ['', `Bearer ${token}`] }, workspace.env),
    ).resolves.toMatchObject({ userId: 'user-1' });
    await expect(
      verifyToken(token, workspace.env),
    ).resolves.toMatchObject({ userId: 'user-1', deviceId: 'device-1' });
  });

  it('reads header values through the shared helper', () => {
    expect(readHeaderValue({ 'X-User-Id': 'user-1' }, 'x-user-id')).toBe('user-1');
    expect(readHeaderValue(new Headers({ 'x-device-id': 'device-1' }), 'X-Device-Id')).toBe(
      'device-1',
    );
    expect(readHeaderValue(undefined, 'authorization')).toBeNull();
  });
});

describe('JWT failures', () => {
  it('reports a missing authorization header', async () => {
    const error = await expectJwtError(
      verifyAuthorizationHeader(undefined, workspace.env),
      'jwt_missing',
    );
    expect(error.message).not.toContain('undefined');
  });

  it('reports an invalid token without leaking it', async () => {
    const token = 'not-a-jwt';
    const error = await expectJwtError(
      verifyAuthorizationHeader({ authorization: `Bearer ${token}` }, workspace.env),
      'jwt_invalid',
    );
    expect(error.message).not.toContain(token);
  });

  it('reports expired tokens as invalid', async () => {
    const token = await signToken(workspace.env, {}, { expired: true });
    await expectJwtError(
      verifyAuthorizationHeader({ authorization: `Bearer ${token}` }, workspace.env),
      'jwt_invalid',
    );
  });

  it('rejects tokens signed with another key', async () => {
    const token = await signToken(workspace.env, {}, { key: OTHER_SIGNING_KEY });
    await expectJwtError(
      verifyAuthorizationHeader({ authorization: `Bearer ${token}` }, workspace.env),
      'jwt_invalid',
    );
  });

  it('rejects the wrong issuer or audience', async () => {
    const wrongIssuer = await signToken(workspace.env, {}, { issuer: 'other-issuer' });
    const wrongAudience = await signToken(workspace.env, {}, { audience: 'other-audience' });
    await expectJwtError(
      verifyAuthorizationHeader({ authorization: wrongIssuer }, workspace.env),
      'jwt_invalid',
    );
    await expectJwtError(
      verifyAuthorizationHeader({ authorization: wrongAudience }, workspace.env),
      'jwt_invalid',
    );
  });

  it('reports missing user and device claims separately', async () => {
    const noUser = await signToken(workspace.env, { userId: undefined, sub: undefined });
    const noDevice = await signToken(workspace.env, { deviceId: undefined });

    await expectJwtError(
      verifyAuthorizationHeader({ authorization: noUser }, workspace.env),
      'jwt_claim_missing',
    );
    await expectJwtError(
      verifyAuthorizationHeader({ authorization: noDevice }, workspace.env),
      'jwt_claim_missing',
    );
  });
});

