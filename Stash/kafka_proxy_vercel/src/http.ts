/** HTTP helpers shared by the Vercel functions: typed errors, JSON, CORS, body limits. */

export type HeaderMap = Record<string, string>;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(body: unknown, status: number, headers: HeaderMap = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: HeaderMap = {},
): Response {
  return jsonResponse({ ok: false, error: { code, message } }, status, headers);
}

export function methodNotAllowed(allowed: string[]): HttpError {
  return new HttpError(405, 'method_not_allowed', `Use ${allowed.join(' or ')}.`);
}

export function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number((raw ?? '').trim());
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** Reads a JSON body, rejecting anything above the configured byte budget. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'body_too_large', `Body exceeds ${maxBytes} bytes.`);
  }

  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new HttpError(413, 'body_too_large', `Body exceeds ${maxBytes} bytes.`);
  }
  if (!text.trim()) {
    throw new HttpError(400, 'invalid_request', 'A JSON body is required.');
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_request', 'Body must be valid JSON.');
  }
}

export function parseCorsOrigins(raw: string | undefined): '*' | string[] {
  const value = (raw ?? '').trim();
  if (!value || value === '*') {
    return '*';
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function buildCorsHeaders(origin: string | null, allowed: '*' | string[]): HeaderMap {
  const allowedOrigin = allowed === '*' ? '*' : origin && allowed.includes(origin) ? origin : '';
  if (!allowedOrigin) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
