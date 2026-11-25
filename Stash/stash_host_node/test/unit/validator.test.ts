import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OTHER_SIGNING_KEY,
  authorizationHeader,
  createWorkspace,
  signToken,
  validRequest,
} from '../helpers/env';
import {
  RejectError,
  validateRequest,
} from '../../src/validation/requestValidator';
import type { RejectCode } from '../../src/validation/requestValidator';

const workspace = createWorkspace();
let headers: Record<string, string>;

beforeAll(async () => {
  headers = await authorizationHeader(workspace.env);
});

afterAll(() => workspace.cleanup());

async function expectReject(
  rawValue: unknown,
  key: string,
  requestHeaders: Record<string, string> | undefined,
  code: RejectCode,
): Promise<void> {
  try {
    await validateRequest(rawValue, key, requestHeaders, workspace.env);
    throw new Error(`Expected reject ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RejectError);
    expect((error as RejectError).code).toBe(code);
  }
}

describe('validateRequest success', () => {
  it('accepts a valid v2 request and canonicalizes the file id', async () => {
    const upperHash = 'A'.repeat(64);
    const request = validRequest({
      fileId: upperHash,
      storageProvider: 's3',
      storageTempPath: `/temp/uploads/device-1/${upperHash}/photo.heic`,
    });

    const validated = await validateRequest(
      JSON.stringify(request),
      upperHash,
      headers,
      workspace.env,
    );

    expect(validated.version).toBe(2);
    expect(validated.fileId).toBe('a'.repeat(64));
    expect(validated.requestFileId).toBe(upperHash);
    expect(validated.storageProvider).toBe('S3');
    expect(validated.userId).toBe('user-1');
    expect(validated.deviceId).toBe('device-1');
    expect(validated.storageKey).toBe(
      `stash/temp/uploads/device-1/${upperHash}/photo.heic`,
    );
    expect(validated.metadataJson).toContain('createdAt');
  });

  it('accepts a parsed object as well as a JSON string', async () => {
    const request = validRequest();
    const validated = await validateRequest(request, 'a'.repeat(64), headers, workspace.env);
    expect(validated.correlationId).toBe('correlation-1');
  });
});

describe('validateRequest rejections', () => {
  it('rejects invalid JSON', async () => {
    await expectReject('{', 'a'.repeat(64), headers, 'invalid_json');
  });

  it('rejects unsupported versions', async () => {
    await expectReject(
      JSON.stringify(validRequest({ version: 1 })),
      'a'.repeat(64),
      headers,
      'unsupported_version',
    );
  });

  it('rejects unsupported storage providers', async () => {
    await expectReject(
      JSON.stringify(validRequest({ storageProvider: 'MEGA' })),
      'a'.repeat(64),
      headers,
      'invalid_storage_provider',
    );
  });

  it('rejects traversal in storageTempPath', async () => {
    await expectReject(
      JSON.stringify(validRequest({ storageTempPath: '/temp/../evil.heic' })),
      'a'.repeat(64),
      headers,
      'invalid_payload',
    );
    await expectReject(
      JSON.stringify(validRequest({ storageTempPath: '/temp/uploads/x/../../evil.heic' })),
      'a'.repeat(64),
      headers,
      'invalid_payload',
    );
  });

  it('rejects malformed MIME types', async () => {
    await expectReject(
      JSON.stringify(validRequest({ mimeType: 'image' })),
      'a'.repeat(64),
      headers,
      'invalid_payload',
    );
    await expectReject(
      JSON.stringify(validRequest({ mimeType: 'image/ jpeg' })),
      'a'.repeat(64),
      headers,
      'invalid_payload',
    );
  });

  it('rejects unsafe file names', async () => {
    await expectReject(
      JSON.stringify(validRequest({ fileName: '../photo.heic' })),
      'a'.repeat(64),
      headers,
      'invalid_payload',
    );
    await expectReject(
      JSON.stringify(validRequest({ fileName: 'dir/photo.heic' })),
      'a'.repeat(64),
      headers,
      'invalid_payload',
    );
  });

  it('rejects oversized metadata', async () => {
    await expectReject(
      JSON.stringify(validRequest({ metadata: { blob: 'x'.repeat(70_000) } })),
      'a'.repeat(64),
      headers,
      'invalid_payload',
    );
  });

  it('rejects a missing JWT', async () => {
    await expectReject(
      JSON.stringify(validRequest()),
      'a'.repeat(64),
      {},
      'jwt_missing',
    );
  });

  it('rejects an invalid JWT', async () => {
    await expectReject(
      JSON.stringify(validRequest()),
      'a'.repeat(64),
      { authorization: 'Bearer not-a-jwt' },
      'jwt_invalid',
    );
  });

  it('rejects an expired JWT', async () => {
    const token = await signToken(workspace.env, {}, { expired: true });
    await expectReject(
      JSON.stringify(validRequest()),
      'a'.repeat(64),
      { authorization: `Bearer ${token}` },
      'jwt_invalid',
    );
  });

  it('rejects a JWT signed with the wrong key', async () => {
    const token = await signToken(workspace.env, {}, { key: OTHER_SIGNING_KEY });
    await expectReject(
      JSON.stringify(validRequest()),
      'a'.repeat(64),
      { authorization: `Bearer ${token}` },
      'jwt_invalid',
    );
  });

  it('rejects a JWT with missing claims', async () => {
    const token = await signToken(workspace.env, { userId: undefined, sub: undefined });
    await expectReject(
      JSON.stringify(validRequest()),
      'a'.repeat(64),
      { authorization: `Bearer ${token}` },
      'jwt_claim_missing',
    );
  });

  it('rejects payload identity that differs from the JWT', async () => {
    await expectReject(
      JSON.stringify(validRequest({ userId: 'other-user' })),
      'a'.repeat(64),
      headers,
      'identity_mismatch',
    );
  });

  it('rejects header identity that differs from the JWT', async () => {
    await expectReject(
      JSON.stringify(validRequest()),
      'a'.repeat(64),
      { ...headers, 'x-user-id': 'other-user' },
      'identity_mismatch',
    );
    await expectReject(
      JSON.stringify(validRequest()),
      'a'.repeat(64),
      { ...headers, 'x-device-id': 'other-device' },
      'identity_mismatch',
    );
  });

  it('rejects a correlation header that does not match the payload', async () => {
    await expectReject(
      JSON.stringify(validRequest()),
      'a'.repeat(64),
      { ...headers, 'x-correlation-id': 'other-correlation' },
      'invalid_payload',
    );
  });

  it('rejects a missing correlation id', async () => {
    const request = validRequest();
    delete request['correlationId'];
    await expectReject(JSON.stringify(request), 'a'.repeat(64), headers, 'correlation_missing');
  });

  it('rejects a missing Kafka key', async () => {
    await expectReject(JSON.stringify(validRequest()), '', headers, 'kafka_key_missing');
  });

  it('rejects a Kafka key that does not match the file id', async () => {
    await expectReject(
      JSON.stringify(validRequest()),
      'c'.repeat(64),
      headers,
      'kafka_key_mismatch',
    );
  });
});
