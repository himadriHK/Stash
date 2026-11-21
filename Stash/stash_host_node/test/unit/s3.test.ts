import type { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  S3AccessError,
  S3NotFoundError,
  S3Storage,
  S3TransientError,
  classifyS3Error,
} from '../../src/storage/s3';
import { createWorkspace } from '../helpers/env';
import type { TestWorkspace } from '../helpers/env';

let workspace: TestWorkspace | null = null;

afterEach(() => {
  workspace?.cleanup();
  workspace = null;
});

function fakeClient(
  send: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>,
): S3Client {
  return { send } as unknown as S3Client;
}

function awsError(name: string, status?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });
}

describe('S3Storage key mapping', () => {
  it('maps logical paths with the configured prefix', () => {
    workspace = createWorkspace();
    const storage = new S3Storage(workspace.env, { client: fakeClient(async () => ({})) });
    expect(storage.keyForLogicalPath('/temp/uploads/dev1/abc/IMG.heic')).toBe(
      'stash/temp/uploads/dev1/abc/IMG.heic',
    );
  });

  it('honors an empty prefix', () => {
    workspace = createWorkspace({ S3_PREFIX: '' });
    const storage = new S3Storage(workspace.env, { client: fakeClient(async () => ({})) });
    expect(storage.keyForLogicalPath('/temp/uploads/dev1/abc/IMG.heic')).toBe(
      'temp/uploads/dev1/abc/IMG.heic',
    );
  });
});

describe('S3 error classification', () => {
  it('classifies 404/NoSuchKey as not found', () => {
    expect(classifyS3Error(awsError('NoSuchKey', 404))).toBeInstanceOf(S3NotFoundError);
    expect(classifyS3Error(awsError('NotFound'))).toBeInstanceOf(S3NotFoundError);
  });

  it('classifies 403 as access denied', () => {
    expect(classifyS3Error(awsError('Forbidden', 403))).toBeInstanceOf(S3AccessError);
    expect(classifyS3Error(awsError('AccessDenied'))).toBeInstanceOf(S3AccessError);
  });

  it('classifies 429, 5xx and timeouts as transient', () => {
    expect(classifyS3Error(awsError('TooManyRequests', 429))).toBeInstanceOf(S3TransientError);
    expect(classifyS3Error(awsError('InternalError', 500))).toBeInstanceOf(S3TransientError);
    expect(classifyS3Error(awsError('TimeoutError'))).toBeInstanceOf(S3TransientError);
    expect(classifyS3Error(awsError('TimeoutError')).retryable).toBe(true);
  });

  it('keeps typed errors and marks unknown failures as non-retryable', () => {
    const existing = new S3AccessError();
    expect(classifyS3Error(existing)).toBe(existing);
    const unknown = classifyS3Error(new Error('boom'));
    expect(unknown.code).toBe('S3_ERROR');
    expect(unknown.retryable).toBe(false);
  });
});

describe('S3Storage typed operations with an injected client', () => {
  it('returns null for a missing object on headObject', async () => {
    workspace = createWorkspace({ S3_BUCKET: 'test-bucket' });
    const storage = new S3Storage(workspace.env, {
      client: fakeClient(async () => {
        throw awsError('NoSuchKey', 404);
      }),
    });
    await expect(storage.headObject('missing/key.jpg')).resolves.toBeNull();
  });

  it('resolves deleteObject when the object is already gone', async () => {
    workspace = createWorkspace({ S3_BUCKET: 'test-bucket' });
    const storage = new S3Storage(workspace.env, {
      client: fakeClient(async () => {
        throw awsError('NoSuchKey', 404);
      }),
    });
    await expect(storage.deleteObject('missing/key.jpg')).resolves.toBeUndefined();
  });

  it('throws typed errors for denied and unavailable requests', async () => {
    workspace = createWorkspace({ S3_BUCKET: 'test-bucket' });
    const denied = new S3Storage(workspace.env, {
      client: fakeClient(async () => {
        throw awsError('Forbidden', 403);
      }),
    });
    await expect(denied.getObjectStream('key')).rejects.toBeInstanceOf(S3AccessError);

    const unavailable = new S3Storage(workspace.env, {
      client: fakeClient(async () => {
        throw awsError('InternalError', 503);
      }),
    });
    await expect(unavailable.headBucket()).rejects.toBeInstanceOf(S3TransientError);
  });
});

