/**
 * UniFi's Cloud Site Manager API authenticates with a single static
 * `X-API-Key` header tied to a UI.com account - there is no OAuth dance and
 * no per-request token exchange.
 *
 * Structurally verified (checked directly): this connector's own code makes
 * zero mutating calls. The 9 Site Manager functions in client.ts are reads
 * (one is a filtered-read POST), and networkGet only sends GET to fixed
 * Network API paths through the connector proxy - no tool takes a
 * free-form path.
 *
 * Vendor-documented, not independently verified (hedged deliberately):
 * Ubiquiti's own docs describe the key as read-only ("cannot be used to
 * make modifications to your UniFi infrastructure"). The live spec defines
 * a 10th path, `/v1/connector/consoles/{id}/*path`, a generic reverse-proxy
 * supporting all 5 HTTP methods; this connector uses it for GET only (see
 * README's Authentication section). Whether UI.com's backend actually blocks
 * writes sent through that path, versus it being documented policy rather
 * than a hard technical block, has not been tested by WYRE.
 */
export interface UniFiCredentials {
  apiKey: string;
}

/** Thrown when UniFi rejects the API key (HTTP 401) - distinct from rate limiting so callers get an honest error. */
export class UniFiAuthError extends Error {}

/** Thrown when UniFi rate-limits the request (HTTP 429) - distinct from an auth failure. */
export class UniFiRateLimitError extends Error {}

/** Thrown for any other non-2xx / unexpected vendor response. */
export class UniFiApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

// ---------------------------------------------------------------------
// Shared envelope / pagination
// ---------------------------------------------------------------------

export interface PageParams {
  pageSize?: number;
  nextToken?: string;
}

/** Common response envelope shape used by list endpoints. */
export interface PagedResponse<T> {
  data: T[];
  httpStatusCode?: number;
  traceId?: string;
  nextToken?: string;
  [key: string]: unknown;
}

/** Common response envelope shape used by single-resource endpoints. */
export interface SingleResponse<T> {
  data: T;
  httpStatusCode?: number;
  traceId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Sites - GET /v1/sites
// ---------------------------------------------------------------------

export interface ListSitesParams extends PageParams {}

export interface UniFiSite {
  siteId: string;
  hostId: string;
  /** Name, description, timezone, gateway MAC. Structure varies by UniFi Network version. */
  meta?: Record<string, unknown>;
  /** Device/client counts and network performance metrics. Structure varies by UniFi Network version. */
  statistics?: Record<string, unknown>;
  permission?: string;
  isOwner?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Hosts - GET /v1/hosts, GET /v1/hosts/{id}
// ---------------------------------------------------------------------

export interface ListHostsParams extends PageParams {}

export interface UniFiHost {
  id: string;
  hardwareId?: string;
  type?: string;
  ipAddress?: string;
  owner?: boolean;
  isBlocked?: boolean;
  registrationTime?: string;
  lastConnectionStateChange?: string;
  latestBackupTime?: string;
  userData?: Record<string, unknown>;
  reportedState?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Devices - GET /v1/devices
// ---------------------------------------------------------------------

export interface ListDevicesParams extends PageParams {
  hostIds?: string[];
  time?: string;
}

export interface UniFiDeviceHostGroup {
  hostId: string;
  hostName?: string;
  devices: UniFiDevice[];
  [key: string]: unknown;
}

export interface UniFiDevice {
  id: string;
  mac: string;
  name?: string;
  model?: string;
  shortname?: string;
  ip?: string;
  productLine?: string | null;
  status?: string;
  version?: string;
  firmwareStatus?: string;
  updateAvailable?: string | null;
  isConsole?: boolean | null;
  isManaged?: boolean | null;
  startupTime?: string | null;
  adoptionTime?: string | null;
  note?: string | null;
  uidb?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// ISP Metrics - GET /v1/isp-metrics/{type}, POST /v1/isp-metrics/{type}/query
// ---------------------------------------------------------------------

export type IspMetricsInterval = '5m' | '1h';

export interface GetIspMetricsParams {
  beginTimestamp?: string;
  endTimestamp?: string;
  duration?: '24h' | '7d' | '30d';
}

export interface IspMetricPeriod {
  data?: { wan?: Record<string, unknown>; [key: string]: unknown };
  metricTime?: string;
  version?: string;
  [key: string]: unknown;
}

export interface IspMetricEntry {
  metricType?: string;
  periods?: IspMetricPeriod[];
  hostId?: string;
  siteId?: string;
  [key: string]: unknown;
}

export interface QueryIspMetricsSiteFilter {
  hostId: string;
  siteId: string;
  beginTimestamp?: string;
  endTimestamp?: string;
}

export interface QueryIspMetricsParams {
  sites: QueryIspMetricsSiteFilter[];
}

export interface QueryIspMetricsResult {
  metrics?: IspMetricEntry[];
  message?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// SD-WAN Configs - GET /v1/sd-wan-configs, GET /v1/sd-wan-configs/{id},
// GET /v1/sd-wan-configs/{id}/status
// ---------------------------------------------------------------------

export interface UniFiSdWanConfigSummary {
  id: string;
  name?: string;
  type?: 'sdwan-hbsp';
  [key: string]: unknown;
}

export interface UniFiSdWanConfig extends UniFiSdWanConfigSummary {
  variant?: 'distributed' | 'failover' | 'single';
  settings?: Record<string, unknown>;
  hubs?: Array<Record<string, unknown>>;
  spokes?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface UniFiSdWanConfigStatus {
  id: string;
  fingerprint?: string;
  updatedAt?: number;
  hubs?: Array<Record<string, unknown>>;
  spokes?: Array<Record<string, unknown>>;
  lastGeneratedAt?: number;
  generateStatus?: 'OK' | 'GENERATING' | 'GENERATE_FAILED';
  errors?: unknown[];
  warnings?: unknown[];
  [key: string]: unknown;
}
