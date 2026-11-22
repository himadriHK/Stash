/**
 * AWS Signature V4 query-string presigning for S3.
 *
 * React Native/Hermes has no WebCrypto, so the HMAC chain is computed with the
 * pure-JS `js-sha256` package. Presigned URLs sign only the `host` header and
 * use `UNSIGNED-PAYLOAD` for every method: SigV4 query-string presigning has no
 * payload to hash when the URL is minted, and AWS/S3-compatible services reject
 * a presigned request whose canonical request carries a real payload hash.
 * Integrity comes from the content hash in the object key instead.
 */
import { sha256 } from 'js-sha256';

export interface S3SigningConfig {
  Bucket: string;
  Region: string;
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken?: string;
  Endpoint?: string;
  ForcePathStyle?: boolean;
}

const MIN_EXPIRY_SECONDS = 1;
const MAX_EXPIRY_SECONDS = 604800;
const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

interface ParsedEndpoint {
  protocol: string;
  host: string;
  path: string;
}

interface QueryParameter {
  key: string;
  value: string;
}

/**
 * RFC3986 encoding for SigV4: `encodeURIComponent` leaves `!'()*` untouched,
 * but AWS requires them percent-encoded as well.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes each path segment separately so `/` separators are preserved. */
function encodeObjectKey(objectKey: string): string {
  return objectKey.split('/').map(encodeRfc3986).join('/');
}

/** Parses `https://host/path` with a small regex (Hermes lacks the WHATWG URL constructor). */
function parseEndpoint(endpoint: string): ParsedEndpoint {
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/.exec(endpoint);
  if (!match) {
    throw new Error(`Invalid S3 endpoint "${endpoint}". Expected https://host[/path].`);
  }
  const [, protocol, host, rawPath] = match;
  const path = (rawPath ?? '').replace(/\/+$/, '');
  return { protocol, host, path };
}

/** `now.toISOString()` -> `yyyyMMddTHHmmssZ` (no `-`, `:` or milliseconds). */
function formatAmzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Converts a hex digest (an HMAC output) back into raw bytes for the next HMAC. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function clampExpirySeconds(expiresSeconds: number): number {
  if (!Number.isFinite(expiresSeconds)) {
    return MIN_EXPIRY_SECONDS;
  }
  return Math.min(MAX_EXPIRY_SECONDS, Math.max(MIN_EXPIRY_SECONDS, Math.trunc(expiresSeconds)));
}

function buildCanonicalQuery(parameters: QueryParameter[]): string {
  return parameters
    .map((parameter) => ({
      key: encodeRfc3986(parameter.key),
      value: encodeRfc3986(parameter.value),
    }))
    .sort((left, right) => {
      if (left.key !== right.key) {
        return left.key < right.key ? -1 : 1;
      }
      if (left.value === right.value) {
        return 0;
      }
      return left.value < right.value ? -1 : 1;
    })
    .map((parameter) => `${parameter.key}=${parameter.value}`)
    .join('&');
}

/**
 * Builds a presigned S3 URL for a single object.
 *
 * `expiresSeconds` is clamped to the SigV4 1..604800 range. The canonical
 * request always uses `UNSIGNED-PAYLOAD`, as SigV4 query-string presigning
 * requires.
 */
export function presignS3Url(
  config: S3SigningConfig,
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
  objectKey: string,
  expiresSeconds: number,
  now: Date = new Date(),
): string {
  const endpoint = config.Endpoint?.trim()
    ? parseEndpoint(config.Endpoint.trim())
    : parseEndpoint(`https://s3.${config.Region}.amazonaws.com`);
  const forcePathStyle = config.ForcePathStyle === true;
  const encodedKey = encodeObjectKey(objectKey);
  const canonicalUri = forcePathStyle
    ? `${endpoint.path}/${config.Bucket}/${encodedKey}`
    : `${endpoint.path}/${encodedKey}`;
  const host = forcePathStyle ? endpoint.host : `${config.Bucket}.${endpoint.host}`;

  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.Region}/${SERVICE}/aws4_request`;
  const expiry = clampExpirySeconds(expiresSeconds);

  const parameters: QueryParameter[] = [
    { key: 'X-Amz-Algorithm', value: ALGORITHM },
    { key: 'X-Amz-Credential', value: `${config.AccessKeyId}/${scope}` },
    { key: 'X-Amz-Date', value: amzDate },
    { key: 'X-Amz-Expires', value: String(expiry) },
    { key: 'X-Amz-SignedHeaders', value: 'host' },
  ];
  const sessionToken = config.SessionToken?.trim();
  if (sessionToken) {
    parameters.push({ key: 'X-Amz-Security-Token', value: sessionToken });
  }
  const canonicalQuery = buildCanonicalQuery(parameters);

  // The canonical headers block already ends with a newline, so joining adds
  // the required blank line before the signed-header list.
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');

  const dateKey = hexToBytes(sha256.hmac(`AWS4${config.SecretAccessKey}`, dateStamp));
  const regionKey = hexToBytes(sha256.hmac(dateKey, config.Region));
  const serviceKey = hexToBytes(sha256.hmac(regionKey, SERVICE));
  const signingKey = hexToBytes(sha256.hmac(serviceKey, 'aws4_request'));
  const signature = sha256.hmac(signingKey, stringToSign);

  return `${endpoint.protocol}://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
