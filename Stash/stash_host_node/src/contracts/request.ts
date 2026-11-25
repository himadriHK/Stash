import { z } from 'zod';

export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_IDENTIFIER_LENGTH = 128;

const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function isSafeFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

export function isSafeLogicalPath(value: string): boolean {
  if (!value.startsWith('/temp/') || value.length > 1024) return false;
  if (value.includes('\\')) return false;

  const segments = value.split('/').slice(1);
  if (segments.length === 0) return false;

  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !CONTROL_CHARACTER_PATTERN.test(segment),
  );
}

export function isSafeUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

export function isSafeDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

const isoDateString = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'Must be an ISO-8601 date-time',
);

const metadataSchema = z.record(z.string(), z.unknown());

export const uploadRequestSchema = z
  .object({
    messageId: z
      .string()
      .min(1)
      .max(MAX_IDENTIFIER_LENGTH)
      .refine((value) => value.trim() !== '', 'Required'),
    timestamp: isoDateString.optional(),
    fileId: z.string().regex(SHA256_PATTERN, 'Must be a 64-character hex SHA-256 value').transform((value) => value.toLowerCase()),
    fileName: z.string().refine(isSafeFileName, 'Must be a safe file name without separators or traversal segments'),
    mimeType: z
      .string()
      .transform((value) => value.toLowerCase())
      .pipe(z.string().regex(MIME_TYPE_PATTERN, 'Must be a valid type/subtype MIME value')),
    storageTempPath: z.string().refine(isSafeLogicalPath, 'Must be a logical /temp/ path without traversal'),
    storageProvider: z
      .string()
      .refine((value) => value.trim().toLowerCase() === 's3', 'Only the S3 storage provider is supported')
      .transform(() => 'S3' as const),
    metadata: metadataSchema.nullable().optional(),
    deviceId: z.string().refine(isSafeDeviceId, 'Must be a safe device identifier').optional(),
    userId: z.string().refine(isSafeUserId, 'Must be a safe user identifier').optional(),
    correlationId: z
      .string()
      .min(1)
      .max(MAX_IDENTIFIER_LENGTH)
      .refine((value) => value.trim() !== '', 'Required'),
    version: z.literal(2),
  })
  .superRefine((value, context) => {
    if (!value.metadata) return;

    let serialized: string;
    try {
      serialized = JSON.stringify(value.metadata);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['metadata'],
        message: 'Must be JSON-serializable',
      });
      return;
    }

    if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['metadata'],
        message: `Must be at most ${MAX_METADATA_BYTES} bytes when serialized`,
      });
    }

    for (const field of ['createdAt', 'modifiedAt'] as const) {
      const entry = value.metadata[field];
      if (entry === undefined) continue;
      if (typeof entry !== 'string' || Number.isNaN(Date.parse(entry))) {
        context.addIssue({
          code: 'custom',
          path: ['metadata', field],
          message: 'Must be an ISO-8601 date-time',
        });
      }
    }
  });

export type UploadRequestInput = z.infer<typeof uploadRequestSchema>;

export interface ValidatedUploadRequest
  extends Omit<UploadRequestInput, 'fileId' | 'userId' | 'deviceId'> {
  fileId: string;
  requestFileId: string;
  userId: string;
  deviceId: string;
  storageKey: string;
  metadataJson: string | null;
}


