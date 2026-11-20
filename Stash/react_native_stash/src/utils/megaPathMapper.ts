/**
 * Port of StashHost.Shared/Services/MegaPathMapper.cs.
 *
 * MegaConnectivity.Core only addresses the account root, so the host encodes
 * every logical Stash path into one root-level file name. The app must upload
 * the temporary file under exactly the same name, otherwise the host's
 * DownloadFileActivity (which recomputes the name from the Kafka request) will
 * not find it.
 */
import { sha256 } from 'js-sha256';

const MAX_BASE_NAME_LENGTH = 180;

function sanitize(segment: string): string {
  let result = '';
  // Iterate UTF-16 code units, matching C# `char` semantics.
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    result += /[\p{L}\p{N}._-]/u.test(char) ? char : '_';
  }
  return result;
}

function splitExtension(fileName: string): { stem: string; extension: string } {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) {
    return { stem: fileName, extension: '' };
  }
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot) };
}

/**
 * Returns the root-level mega.io file name for a logical remote path.
 * A single-segment path is returned unchanged, mirroring the host mapper.
 */
export function toMegaPhysicalName(remotePath: string): string {
  if (!remotePath || remotePath.trim().length === 0) {
    throw new Error('Remote path cannot be empty.');
  }

  const normalized = remotePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new Error('Remote path must contain a file name.');
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error("Remote path cannot contain '.' or '..' segments.");
  }

  const leaf = sanitize(segments[segments.length - 1]);
  if (leaf.trim().length === 0) {
    throw new Error('Remote path has an invalid file name.');
  }
  if (segments.length === 1) {
    return leaf;
  }

  const { stem, extension } = splitExtension(leaf);
  const prefix = segments.slice(0, -1).map(sanitize).join('_');
  let baseName = prefix.length > 0 ? `${prefix}_${stem}` : stem;
  if (baseName.length > MAX_BASE_NAME_LENGTH) {
    baseName = baseName.slice(0, MAX_BASE_NAME_LENGTH);
  }

  const suffix = sha256(segments.join('/')).slice(0, 8).toLowerCase();
  return `${baseName}_${suffix}${extension}`;
}
