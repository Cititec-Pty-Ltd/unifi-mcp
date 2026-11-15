import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSiteTool } from '../tools/sites.js';
import { runWithCredentials } from '../client.js';
import { jsonResponse, textOf } from './test-helpers.js';

describe('handleSiteTool', () => {
  const fetchMock = vi.fn();
  const creds = { apiKey: 'key-1' };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unifi_list_sites sends the X-API-Key header and hits GET /v1/sites', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ siteId: 's1', hostId: 'h1', meta: { name: 'HQ' } }], httpStatusCode: 200 })
    );

    const result = await runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));

    expect(result.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/v1/sites');
    expect(new URL(url).origin).toBe('https://api.ui.com');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('key-1');
    expect(JSON.parse(textOf(result)).data[0].siteId).toBe('s1');
  });

  it('forwards pageSize and nextToken as query params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await runWithCredentials(creds, () =>
      handleSiteTool('unifi_list_sites', { pageSize: 50, nextToken: 'tok-1' })
    );

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('pageSize')).toBe('50');
    expect(url.searchParams.get('nextToken')).toBe('tok-1');
  });

  it('surfaces a 401 as a readable auth error rather than throwing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, 401));

    const result = await runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/rejected the API key/i);
  });

  it('surfaces a 429 as a readable rate-limit error', async () => {
    // Retry-After longer than the client waits for: reported at once, not retried.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
      })
    );

    const result = await runWithCredentials(creds, () => handleSiteTool('unifi_list_sites', {}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/rate-limited/i);
    expect(textOf(result)).toMatch(/try again in 60 s/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a credential error without calling fetch when no key is configured', async () => {
    const result = await handleSiteTool('unifi_list_sites', {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/UNIFI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
