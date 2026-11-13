import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './utils/logger.js';
import { UniFiApiError, UniFiAuthError, UniFiRateLimitError } from './types.js';
import type {
  GetIspMetricsParams,
  IspMetricEntry,
  ListDevicesParams,
  ListHostsParams,
  ListSitesParams,
  PagedResponse,
  QueryIspMetricsParams,
  QueryIspMetricsResult,
  SingleResponse,
  UniFiCredentials,
  UniFiDeviceHostGroup,
  UniFiHost,
  UniFiSdWanConfig,
  UniFiSdWanConfigStatus,
  UniFiSdWanConfigSummary,
  UniFiSite,
} from './types.js';

export const BASE_URL = 'https://api.ui.com';

// Request-scoped credential store. In gateway mode the HTTP layer runs each
// request inside runWithCredentials({apiKey}); getCredentials() reads from
// it. Falls back to process.env for stdio/single-tenant mode.
const credStore = new AsyncLocalStorage<UniFiCredentials>();

export function runWithCredentials<T>(creds: UniFiCredentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

export function getCredentials(): UniFiCredentials | null {
  const scoped = credStore.getStore();
  if (scoped?.apiKey) return scoped;
  const apiKey = process.env.UNIFI_API_KEY;
  if (!apiKey) {
    logger.warn('Missing credentials', { hasApiKey: !!apiKey });
    return null;
  }
  return { apiKey };
}

function buildQuery(params: Record<string, unknown> = {}): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, String(v));
      continue;
    }
    qs.append(key, String(value));
  }
  return qs;
}

async function request<T>(
  creds: UniFiCredentials,
  method: 'GET' | 'POST',
  path: string,
  options: { query?: Record<string, unknown>; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const qs = options.query ? buildQuery(options.query).toString() : '';
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-API-Key': creds.apiKey,
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });

  // 401 (invalid/revoked API key) and 429 (rate-limited) are distinct
  // failure modes with distinct remediations - grouping them under one
  // generic auth-error class hides a transient rate limit behind a message
  // that reads like a bad/expired key.
  if (res.status === 401) {
    throw new UniFiAuthError(`UniFi rejected the API key (HTTP 401): ${path}`);
  }
  if (res.status === 429) {
    throw new UniFiRateLimitError(`UniFi rate-limited the request (HTTP 429): ${path}`);
  }
  if (!res.ok) {
    throw new UniFiApiError(`UniFi ${path} failed: HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

async function doGet<T>(
  creds: UniFiCredentials,
  path: string,
  query?: Record<string, unknown>
): Promise<T> {
  return request<T>(creds, 'GET', path, { query });
}

async function doPost<T>(creds: UniFiCredentials, path: string, body: unknown): Promise<T> {
  return request<T>(creds, 'POST', path, { body });
}

// ---------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------

/** GET /v1/sites - all sites (from hosts running the UniFi Network application) visible to this API key's UI.com account. */
export async function listSites(
  creds: UniFiCredentials,
  params: ListSitesParams = {}
): Promise<PagedResponse<UniFiSite>> {
  return doGet(creds, '/v1/sites', { ...params });
}

// ---------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------

/** GET /v1/hosts - all hosts (consoles / network servers) associated with this API key's UI.com account. */
export async function listHosts(
  creds: UniFiCredentials,
  params: ListHostsParams = {}
): Promise<PagedResponse<UniFiHost>> {
  return doGet(creds, '/v1/hosts', { ...params });
}

/** GET /v1/hosts/{id} - detailed information about a specific host. */
export async function getHost(creds: UniFiCredentials, id: string): Promise<SingleResponse<UniFiHost>> {
  return doGet(creds, `/v1/hosts/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------

/** GET /v1/devices - UniFi devices managed by hosts this API key's account owns or super-admins, grouped by host. */
export async function listDevices(
  creds: UniFiCredentials,
  params: ListDevicesParams = {}
): Promise<PagedResponse<UniFiDeviceHostGroup>> {
  const { hostIds, ...rest } = params;
  return doGet(creds, '/v1/devices', { 'hostIds[]': hostIds, ...rest });
}

// ---------------------------------------------------------------------
// ISP Metrics - WAN/ISP health and traffic. 5-minute intervals are kept for
// at least 24h, 1-hour intervals for at least 30 days.
// ---------------------------------------------------------------------

/** GET /v1/isp-metrics/{type} - ISP metrics for every site linked to this API key's account. */
export async function getIspMetrics(
  creds: UniFiCredentials,
  type: '5m' | '1h',
  params: GetIspMetricsParams = {}
): Promise<SingleResponse<IspMetricEntry[]> & { data: IspMetricEntry[] }> {
  return doGet(creds, `/v1/isp-metrics/${encodeURIComponent(type)}`, { ...params });
}

/** POST /v1/isp-metrics/{type}/query - ISP metrics scoped to specific host/site pairs and time ranges. Read-only despite the verb: a filtered query, not a mutation. */
export async function queryIspMetrics(
  creds: UniFiCredentials,
  type: '5m' | '1h',
  params: QueryIspMetricsParams
): Promise<SingleResponse<QueryIspMetricsResult>> {
  return doPost(creds, `/v1/isp-metrics/${encodeURIComponent(type)}/query`, params);
}

// ---------------------------------------------------------------------
// SD-WAN Configs
// ---------------------------------------------------------------------

/** GET /v1/sd-wan-configs - all SD-WAN configurations associated with this API key's account. */
export async function listSdWanConfigs(
  creds: UniFiCredentials
): Promise<SingleResponse<UniFiSdWanConfigSummary[]> & { data: UniFiSdWanConfigSummary[] }> {
  return doGet(creds, '/v1/sd-wan-configs');
}

/** GET /v1/sd-wan-configs/{id} - full topology (hubs, spokes, routes, settings) for one SD-WAN configuration. */
export async function getSdWanConfig(
  creds: UniFiCredentials,
  id: string
): Promise<SingleResponse<UniFiSdWanConfig>> {
  return doGet(creds, `/v1/sd-wan-configs/${encodeURIComponent(id)}`);
}

/** GET /v1/sd-wan-configs/{id}/status - deployment status (progress, errors, per-hub/spoke WAN health) for one SD-WAN configuration. */
export async function getSdWanConfigStatus(
  creds: UniFiCredentials,
  id: string
): Promise<SingleResponse<UniFiSdWanConfigStatus>> {
  return doGet(creds, `/v1/sd-wan-configs/${encodeURIComponent(id)}/status`);
}

// ---------------------------------------------------------------------
// Network application (local per-console API), read-only, via the
// Site Manager connector proxy: /v1/connector/consoles/{id}/...
//
// Only GET is ever sent, and only to the fixed paths the tools in
// tools/network.ts build - there is no caller-supplied wildcard path.
// The connector allows 100 requests/minute per console, a 25 s upstream
// timeout and a 10 MB response cap; consoles need firmware >= 5.0.3.
// ---------------------------------------------------------------------

/**
 * The Network OpenAPI spec's server URL includes `/proxy/`, while the
 * connector's own example omits it. Try the spec's form first and fall
 * back to the other only when the first returns 404.
 */
export const NETWORK_CONNECTOR_PREFIXES = ['proxy/network/integration', 'network/integration'] as const;

/** GET a path on a console's local Network API (e.g. `/v1/sites`) through the cloud connector. */
export async function networkGet<T>(
  creds: UniFiCredentials,
  consoleId: string,
  path: string,
  query?: Record<string, unknown>
): Promise<T> {
  if (!path.startsWith('/v1/')) {
    throw new Error(`Network API path must start with /v1/: ${path}`);
  }
  const base = `/v1/connector/consoles/${encodeURIComponent(consoleId)}`;
  let lastError: unknown;
  for (const prefix of NETWORK_CONNECTOR_PREFIXES) {
    try {
      return await request<T>(creds, 'GET', `${base}/${prefix}${path}`, { query, timeoutMs: 30_000 });
    } catch (err) {
      lastError = err;
      if (!(err instanceof UniFiApiError && err.status === 404)) throw err;
    }
  }
  throw lastError;
}
