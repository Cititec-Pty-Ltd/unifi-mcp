import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NETWORK_TOOLS, SENSITIVE_NETWORK_TOOLS, handleNetworkTool } from '../tools/network.js';
import { handleHostTool } from '../tools/hosts.js';
import { resetHostOwnershipCache, resetNetworkPrefixCache, runWithCredentials } from '../client.js';
import { jsonResponse, textOf } from './test-helpers.js';

const CONSOLE = 'ABC123:42';
const SITE = '11111111-2222-3333-4444-555555555555';
const DEVICE = '66666666-7777-8888-9999-000000000000';

describe('handleNetworkTool', () => {
  const fetchMock = vi.fn();
  const creds = { apiKey: 'key-1' };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    resetNetworkPrefixCache();
    resetHostOwnershipCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers the working prefix per console, so later calls make one request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await runWithCredentials(creds, () => handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE }));
    await runWithCredentials(creds, () => handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(fetchMock.mock.calls[2][0] as string).pathname).toBe(
      `/v1/connector/consoles/${encodeURIComponent(CONSOLE)}/network/integration/v1/sites`
    );
  });

  it('treats a 404 on the remembered prefix as not found, without a second request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404));

    await runWithCredentials(creds, () => handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE }));
    const result = await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_get_device', { consoleId: CONSOLE, siteId: SITE, deviceId: DEVICE })
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not share a remembered prefix between consoles', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await runWithCredentials(creds, () => handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE }));
    const result = await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_list_sites', { consoleId: 'OTHER:1' })
    );

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('lists console sites with GET through the connector proxy path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: SITE, name: 'Default' }], totalCount: 1 }));

    const result = await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE })
    );

    expect(result.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      `/v1/connector/consoles/${encodeURIComponent(CONSOLE)}/proxy/network/integration/v1/sites`
    );
    expect(init.method).toBe('GET');
    expect(JSON.parse(textOf(result)).data[0].id).toBe(SITE);
  });

  it('falls back to the path without /proxy/ when the first form returns 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE })
    );

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0] as string).pathname).toBe(
      `/v1/connector/consoles/${encodeURIComponent(CONSOLE)}/network/integration/v1/sites`
    );
  });

  it('does not retry on errors other than 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad gateway' }, 502));

    const result = await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE })
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 502/);
    expect(textOf(result)).not.toMatch(/owned|ownership/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('HTTP 403 from the connector', () => {
    const proxyPath = `/v1/connector/consoles/${encodeURIComponent(CONSOLE)}/proxy/network/integration/v1/sites`;

    async function listHosts(apiKey: string, owner: boolean): Promise<void> {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: CONSOLE, owner }] }));
      await runWithCredentials({ apiKey }, () => handleHostTool('unifi_list_hosts', {}));
    }

    async function listSites(apiKey = creds.apiKey) {
      return runWithCredentials({ apiKey }, () => handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE }));
    }

    it('explains the ownership requirement when ownership is not known, with status and path but no key', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403));

      const result = await listSites();

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toBe(
        `Error: UniFi refused access to this console's Network application (HTTP 403: GET ${proxyPath}). ` +
          "The cloud connector only works for consoles owned by the API key's UI.com account; this console is likely shared with it as an admin, not owned (owner: false in unifi_list_hosts confirms this). " +
          'Site Manager tools (unifi_list_hosts, unifi_list_devices, unifi_get_isp_metrics...) still work. ' +
          "Fix: transfer the console's ownership to the key's account, or use the console's local Network API."
      );
      expect(text).not.toContain(creds.apiKey);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('says definitively "not owned" when unifi_list_hosts showed owner: false', async () => {
      await listHosts(creds.apiKey, false);
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403));

      const text = textOf(await listSites());

      expect(text).toContain('this console is not owned by it (unifi_list_hosts shows owner: false)');
      expect(text).toContain("Fix: transfer the console's ownership");
      expect(text).not.toContain('likely');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('points at key permissions and firmware when the account owns the console', async () => {
      await listHosts(creds.apiKey, true);
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403));

      const text = textOf(await listSites());

      expect(text).toContain(`(HTTP 403: GET ${proxyPath})`);
      expect(text).toContain("The API key's UI.com account owns this console, so ownership is not the cause");
      expect(text).toContain("check the API key's permissions");
      expect(text).not.toContain('transfer');
    });

    it('does not use ownership seen with a different API key', async () => {
      await listHosts('other-key', false);
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403));

      expect(textOf(await listSites())).toContain('likely shared');
    });

    it('is terminal: no fallback to the other prefix, and no prefix is remembered', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403));
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await listSites();
      const ok = await listSites();

      expect(ok.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The second call starts from the first prefix again.
      expect(new URL(fetchMock.mock.calls[1][0] as string).pathname).toBe(proxyPath);
    });

    it('on the remembered prefix is terminal and keeps that prefix', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404));
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403));
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await listSites();
      const forbidden = await listSites();
      await listSites();

      expect(textOf(forbidden)).toContain(`/consoles/${encodeURIComponent(CONSOLE)}/network/integration/v1/sites)`);
      expect(textOf(forbidden)).toMatch(/HTTP 403/);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(new URL(fetchMock.mock.calls[3][0] as string).pathname).toBe(
        `/v1/connector/consoles/${encodeURIComponent(CONSOLE)}/network/integration/v1/sites`
      );
    });
  });

  it('passes offset, limit and filter for a site device list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_list_devices', {
        consoleId: CONSOLE,
        siteId: SITE,
        offset: 25,
        limit: 50,
        filter: "state.eq('OFFLINE')",
      })
    );

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toMatch(new RegExp(`/v1/sites/${SITE}/devices$`));
    expect(url.searchParams.get('offset')).toBe('25');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('filter')).toBe("state.eq('OFFLINE')");
  });

  it('builds device statistics paths from siteId and deviceId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ uptimeSec: 100 }));

    await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_get_device_statistics', { consoleId: CONSOLE, siteId: SITE, deviceId: DEVICE })
    );

    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toMatch(
      new RegExp(`/v1/sites/${SITE}/devices/${DEVICE}/statistics/latest$`)
    );
  });

  it('URL-encodes IDs so they cannot change the proxied path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_get_device', { consoleId: CONSOLE, siteId: SITE, deviceId: '../../hotspot/vouchers' })
    );

    const raw = fetchMock.mock.calls[0][0] as string;
    expect(raw).toContain('..%2F..%2Fhotspot%2Fvouchers');
  });

  it('returns an error without calling fetch when a required ID is missing', async () => {
    const result = await runWithCredentials(creds, () =>
      handleNetworkTool('unifi_network_list_clients', { consoleId: CONSOLE })
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/siteId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a credential error without calling fetch when no key is configured', async () => {
    const result = await handleNetworkTool('unifi_network_list_sites', { consoleId: CONSOLE });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/UNIFI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only ever sends GET', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));

    for (const tool of NETWORK_TOOLS) {
      await runWithCredentials(creds, () =>
        handleNetworkTool(tool.name, { consoleId: CONSOLE, siteId: SITE, deviceId: DEVICE, clientId: DEVICE })
      );
    }

    expect(fetchMock).toHaveBeenCalledTimes(NETWORK_TOOLS.length);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).method).toBe('GET');
    }
  });

  it('marks every tool read-only and flags client/device/config tools as sensitive', () => {
    for (const tool of NETWORK_TOOLS) {
      expect(tool.name).toMatch(/^unifi_network_/);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    expect(SENSITIVE_NETWORK_TOOLS.has('unifi_network_list_clients')).toBe(true);
    expect(SENSITIVE_NETWORK_TOOLS.has('unifi_network_list_firewall_policies')).toBe(true);
    expect(SENSITIVE_NETWORK_TOOLS.has('unifi_network_get_info')).toBe(false);
  });
});
