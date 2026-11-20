/**
 * MEGA's JSON API: every call is a POST of a one-element command array to
 * `https://g.api.mega.co.nz/cs`. Errors come back as negative numbers, and the
 * server may ask for a hashcash proof of work via an `X-Hashcash` header.
 */
import {
  MegaError,
  errorFromApiCode,
  isAbortError,
  messageOf,
} from './errors.js';
import { solveHashcash, type HashcashProgress, type Sha256Digest } from './crypto/keys.js';
import { sleep } from './util/async.js';
import type { FetchLike, Logger } from './types.js';

export const DEFAULT_GATEWAY = 'https://g.api.mega.co.nz/';
const MAX_BUSY_RETRIES = 4;
const MAX_HASHCASH_ROUNDS = 3;

export interface MegaApiOptions {
  fetch: FetchLike;
  gateway?: string;
  logger?: Logger;
  /** Injected SHA-256 for hashcash (native digest recommended on mobile). */
  hashcashDigest?: Sha256Digest;
  /** Fully custom hashcash solver; takes precedence over `hashcashDigest`. */
  hashcashSolver?: (challenge: string) => Promise<string>;
  /** Parallel hashcash searches; only helps with an asynchronous digest. */
  hashcashConcurrency?: number;
  /** Reports hashcash progress (a typical challenge takes seconds). */
  hashcashProgress?: (progress: HashcashProgress) => void;
}

interface RawResponse {
  ok?: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class MegaApi {
  readonly fetch: FetchLike;
  readonly gateway: string;
  readonly logger?: Logger;
  sid?: string;

  private readonly hashcashDigest?: Sha256Digest;
  private readonly hashcashSolver?: (challenge: string) => Promise<string>;
  private readonly hashcashConcurrency?: number;
  private readonly hashcashProgress?: (progress: HashcashProgress) => void;
  private counter = Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000;

  constructor(options: MegaApiOptions) {
    this.fetch = options.fetch;
    this.gateway = options.gateway ?? DEFAULT_GATEWAY;
    this.logger = options.logger;
    this.hashcashDigest = options.hashcashDigest;
    this.hashcashSolver = options.hashcashSolver;
    this.hashcashConcurrency = options.hashcashConcurrency;
    this.hashcashProgress = options.hashcashProgress;
  }

  async request<T = unknown>(command: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let hashcash: string | undefined;
    let hashcashRounds = 0;

    for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt++) {
      if (signal?.aborted) throw new MegaError('ABORTED', 'The operation was cancelled');

      // Reuse the same request counter for hashcash retries, like megajs.
      if (!hashcash) this.counter++;

      const query = new URLSearchParams({ id: String(this.counter) });
      if (this.sid) query.set('sid', this.sid);
      const extraQuery = (command as { _querystring?: Record<string, string> })._querystring;
      if (extraQuery) {
        for (const [key, value] of Object.entries(extraQuery)) query.set(key, value);
      }
      const bodyCommand = { ...command };
      delete (bodyCommand as { _querystring?: unknown })._querystring;

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (hashcash) headers['x-hashcash'] = hashcash;

      let response: RawResponse;
      try {
        response = (await this.fetch(`${this.gateway}cs?${query.toString()}`, {
          method: 'POST',
          headers,
          body: JSON.stringify([bodyCommand]),
          signal,
        })) as RawResponse;
      } catch (error) {
        if (isAbortError(error)) throw new MegaError('ABORTED', 'The operation was cancelled');
        throw new MegaError('NETWORK', `MEGA request failed: ${messageOf(error)}`, {
          retryable: true,
          cause: error,
        });
      }

      const challenge = response.headers?.get('x-hashcash');
      if (challenge && hashcashRounds < MAX_HASHCASH_ROUNDS) {
        hashcashRounds++;
        this.logger?.debug?.('mega: solving hashcash challenge');
        hashcash = await this.solveChallenge(challenge, signal);
        attempt--;
        continue;
      }

      if (!response.ok && (response.status < 200 || response.status >= 300)) {
        throw new MegaError('HTTP', `MEGA returned HTTP ${response.status} ${response.statusText ?? ''}`.trim(), {
          retryable: response.status >= 500 || response.status === 429,
        });
      }

      const text = await response.text();
      let payload: unknown;
      try {
        payload = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        throw new MegaError('HTTP', 'MEGA returned an invalid JSON response', { retryable: true });
      }

      let result = Array.isArray(payload) ? payload[0] : payload;
      if (typeof result === 'number' && result < 0) {
        const error = errorFromApiCode(result);
        if (result === -3 && attempt < MAX_BUSY_RETRIES) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw error;
      }

      if (result && typeof result === 'object' && 'sn' in (result as Record<string, unknown>)) {
        const sn = (result as { sn?: string }).sn;
        if (sn) this.logger?.debug?.(`mega: server sequence ${sn}`);
      }

      return result as T;
    }

    throw new MegaError('BUSY', 'MEGA stayed busy after several retries', { retryable: true });
  }

  private solveChallenge(challenge: string, signal?: AbortSignal): Promise<string> {
    if (this.hashcashSolver) return this.hashcashSolver(challenge);
    // The proof of work can take seconds, so it honours the request's abort
    // signal instead of burning CPU after the caller has given up.
    return solveHashcash(challenge, this.hashcashDigest, {
      concurrency: this.hashcashConcurrency,
      signal,
      onProgress: this.hashcashProgress,
    });
  }

  /** Raw GET used for ranged downloads, with MEGA's 509 bandwidth signal surfaced. */
  async getRange(
    url: string,
    rangeStart: number,
    rangeEnd: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let response: RawResponse;
    try {
      response = (await this.fetch(`${url}/${rangeStart}-${rangeEnd}`, { signal })) as RawResponse;
    } catch (error) {
      if (isAbortError(error)) throw new MegaError('ABORTED', 'The operation was cancelled');
      throw new MegaError('NETWORK', `MEGA download failed: ${messageOf(error)}`, {
        retryable: true,
        cause: error,
      });
    }

    if (response.status === 509) {
      const timeLeft = response.headers?.get('x-mega-time-left') ?? 'unknown';
      throw new MegaError(
        'BANDWIDTH_LIMIT',
        `MEGA transfer quota reached (${timeLeft}s until reset)`,
        { retryable: true },
      );
    }

    if (response.status !== 200 && response.status !== 206) {
      throw new MegaError('HTTP', `MEGA download returned HTTP ${response.status}`, {
        retryable: response.status >= 500,
      });
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  /** Raw POST used for upload chunks. Returns the response body bytes. */
  async postChunk(
    url: string,
    offset: number,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let response: RawResponse;
    try {
      response = (await this.fetch(`${url}/${offset}`, {
        method: 'POST',
        headers: { 'content-length': String(body.length) },
        body,
        signal,
      })) as RawResponse;
    } catch (error) {
      if (isAbortError(error)) throw new MegaError('ABORTED', 'The operation was cancelled');
      throw new MegaError('NETWORK', `MEGA upload failed: ${messageOf(error)}`, {
        retryable: true,
        cause: error,
      });
    }

    if (response.status !== 200) {
      throw new MegaError('HTTP', `MEGA upload returned HTTP ${response.status}`, {
        retryable: response.status >= 500 || response.status === 509,
      });
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}
