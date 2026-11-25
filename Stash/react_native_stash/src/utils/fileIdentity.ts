/**
 * Metadata-only file identity.
 *
 * The device never reads file contents to identify a file: identity is the
 * normalised file name, which keeps a 10k-file scan cheap and lets the scanner
 * skip per-entry size lookups entirely. The host recomputes a SHA-256 of the
 * downloaded bytes and deduplicates on that, so byte-identical files from
 * different folders or different devices still collapse there.
 *
 * - `metadataHash` is the local dedup key (`files.metadata_hash`, UNIQUE).
 * - `uploadFileId` is a per-row GUID salted with the metadata hash. It is what
 *   the upload request carries as `fileId` (and what the Kafka record is keyed
 *   by), so it stays a stable 64-hex identifier that is not a content hash.
 *
 * SHA-256 is computed with `expo-crypto` (`digestStringAsync`). This is async
 * and native-backed, so every hashing entry point below is async. Because
 * SHA-256 of a UTF-8 string is identical across implementations, the digests
 * are byte-for-byte identical to the previous pure-JS path, so cross-device
 * identity (a shared file name, and the derived upload file id) is preserved.
 */
import * as Crypto from 'expo-crypto';
import { uuid } from './id';

/** Case/whitespace-insensitive name used for identity comparisons. */
export function normalizeIdentityName(fileName: string): string {
  return fileName.trim().toLowerCase();
}

/** SHA-256 hex of a UTF-8 string, matching the legacy `sha256()` output. */
function sha256Hex(input: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
}

/**
 * Local dedup identity: SHA-256 over the normalised name. Pure metadata - no
 * file bytes are read and no size stat is needed.
 */
export async function computeMetadataHash(fileName: string): Promise<string> {
  return sha256Hex(normalizeIdentityName(fileName));
}

/**
 * Upload identity: the row GUID salted with the metadata hash. Deterministic
 * for a row, unique across rows and devices, and independent of the content.
 */
export async function computeUploadFileId(
  guid: string,
  metadataHash: string,
): Promise<string> {
  return sha256Hex(`${guid.trim()}\u0000${metadataHash.trim().toLowerCase()}`);
}

/** Convenience for callers that only hold the identifying fields. */
export async function computeUploadFileIdForFile(file: {
  id: string;
  metadataHash: string;
}): Promise<string> {
  return computeUploadFileId(file.id, file.metadataHash);
}

/** New GUID for a freshly discovered local file. */
export function newFileGuid(): string {
  return uuid();
}