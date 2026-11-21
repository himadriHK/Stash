import { z } from 'zod';

export const UPLOAD_RESPONSE_VERSION = 1;

export const RESPONSE_STATUSES = ['COMPLETED', 'FAILED'] as const;

export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const THUMBNAIL_SIZES = ['128', '256', '512'] as const;

export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number];

export interface UploadResponseV1 {
  messageId: string;
  timestamp: string;
  fileId: string;
  status: ResponseStatus;
  permanentPath: string | null;
  thumbnails: Record<string, string>;
  convertedFormat: string | null;
  deduplicated: boolean;
  processingTimeMs: number;
  error: string | null;
  deviceId: string;
  userId: string;
  correlationId: string;
  version: typeof UPLOAD_RESPONSE_VERSION;
}

export const uploadResponseSchema = z.object({
  messageId: z.string().min(1),
  timestamp: z.string().min(1),
  fileId: z.string().min(1),
  status: z.enum(RESPONSE_STATUSES),
  permanentPath: z.string().nullable(),
  thumbnails: z.record(z.string(), z.string()),
  convertedFormat: z.string().nullable(),
  deduplicated: z.boolean(),
  processingTimeMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
  deviceId: z.string(),
  userId: z.string(),
  correlationId: z.string(),
  version: z.literal(UPLOAD_RESPONSE_VERSION),
});

export type UploadResponseInput = z.input<typeof uploadResponseSchema>;
