import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSiteTool } from '../tools/sites.js';
import { runWithCredentials } from '../client.js';
import { RATE_LIMIT_RETRY, parseRetryAfter, retryDelayMs } from '../rate-limit.js';
import { jsonResponse, textOf } from './test-helpers.js';

function limited(retryAfter?: string, status = 429): Response {
  return new Response(JSON.stringify({ code: 'rate_limit', message: 'rate limit exceeded' }), {
    status,
    headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
  });
}

describe('parseRetryAfter', () => {
  it('reads delay-seconds, rounding fractions up', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('5.372786998')).toBe(5373);
    expect(parseRetryAfter(' 0 ')).toBe(0);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:07 GMT', now)).toBe(7000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-3')).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it('uses Retry-After when given', () => {
    expect(retryDelayMs(0, 3000, 0)).toBe(3000);
  });

  it('backs off exponentially without Retry-After', () => {
    expect(retryDelayMs(0, undefined, 0, () => 0)).toBe(1000);
    expect(retryDelayMs(1, undefined, 1000, () => 0)).toBe(2000);
  });

  it('stops after maxRetries', () => {
    expect(retryDelayMs(RATE_LIMIT_RETRY.maxRetries, 1000, 0)).toBeUndefined();
  });

  it('does not wait longer than maxWaitMs or past maxTotalWaitMs', () => {
    expect(retryDelayMs(0, RATE_LIMIT_RETRY.maxWaitMs + 1, 0)).toBeUndefined();
    expect(retryDelayMs(1, 5000, RATE_LIMIT_RETRY.maxTotalWaitMs - 4000)).toBeUndefined();
  });
});

describe('request retry on 429', () => {
  const fetchMock = vi.fn();
  const creds = { apiKey: 'key-1' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for Retry-After and returns the retried success', async () => {
    fetchMock.mockResolvedValueOnce(limited('2')).mockResolvedValueOnce(jsonResponse({ data: [] }));

    const pending = runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
  });

  it('gives each attempt a fresh request (new timeout signal)', async () => {
    fetchMock.mockResolvedValueOnce(limited('1')).mockResolvedValueOnce(jsonResponse({ data: [] }));

    const pending = runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect(first.signal).not.toBe(second.signal);
  });

  it('gives up after maxRetries and reports the last Retry-After', async () => {
    fetchMock.mockImplementation(async () => limited('3'));

    const pending = runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT_RETRY.maxRetries + 1);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 429.*try again in 3 s/i);
  });

  it('retries a 503 only when it carries Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(limited(undefined, 503));

    const result = await runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 503/);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(limited('1', 503)).mockResolvedValueOnce(jsonResponse({ data: [] }));
    const pending = runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 500));

    const result = await runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
  });
});
