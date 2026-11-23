import { logger } from './utils/logger.js';

/**
 * Bounded retry for rate-limited UniFi responses.
 *
 * UniFi answers 429 with a `Retry-After` header (seconds; an HTTP date is
 * also accepted). Retry policy: a Retry-After of at most 10 s is waited
 * for and retried once, so a brief burst does not surface as a tool error.
 * With no Retry-After, or a longer one, the 429 is returned at once (no
 * invented backoff), so a tool call is never held for long. A 503 is retried
 * the same way only when it carries Retry-After; every call this client
 * makes is a read, so replaying one cannot change anything.
 */
export const RATE_LIMIT_RETRY = {
  /** Retries after the first attempt (at most one). */
  maxRetries: 1,
  /** Longest wait that is retried. A missing or larger Retry-After is not retried. */
  maxWaitMs: 10_000,
};

/** Parses a Retry-After value into milliseconds from `now`; undefined if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  // Otherwise it must be an HTTP date ("Wed, 21 Oct 2015 07:28:00 GMT").
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Whole seconds from a response's Retry-After header (at least 1), or undefined. */
export function retryAfterSecondsOf(res: Response): number | undefined {
  const ms = parseRetryAfter(res.headers.get('retry-after'));
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Milliseconds to wait before retry number `attempt` (0-based), or
 * undefined when the request should not be retried. Only a Retry-After the
 * vendor sent is waited for: with no header, or one over maxWaitMs, the
 * caller gets the error at once (no invented backoff).
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number | undefined {
  if (attempt >= RATE_LIMIT_RETRY.maxRetries) return undefined;
  if (retryAfterMs === undefined || retryAfterMs > RATE_LIMIT_RETRY.maxWaitMs) return undefined;
  return retryAfterMs;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch() with the bounded retry above. `makeInit` is called for every
 * attempt so each one gets a fresh timeout signal. Returns the last
 * response, which may still be a 429 for the caller to report.
 */
export async function fetchWithRateLimitRetry(
  url: string,
  label: string,
  makeInit: () => RequestInit
): Promise<Response> {
  let res = await fetch(url, makeInit());
  for (let attempt = 0; ; attempt++) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    const retryable = res.status === 429 || (res.status === 503 && retryAfterMs !== undefined);
    if (!retryable) return res;
    const delay = retryDelayMs(attempt, retryAfterMs);
    if (delay === undefined) return res;
    logger.warn('UniFi asked us to slow down; retrying', { status: res.status, path: label, delayMs: delay });
    await res.body?.cancel().catch(() => undefined);
    await sleep(delay);
    res = await fetch(url, makeInit());
  }
}
