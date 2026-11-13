import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials, networkGet } from '../client.js';
import type { CallToolResult } from './types.js';
import { errorResult, requireCredentials, textResult } from './shared.js';

// Read-only tools for a console's local UniFi Network API, reached through the
// Site Manager connector proxy. Every tool is a fixed GET path; nothing here
// accepts a free-form path or sends a mutating verb.
//
// Sensitivity: tools marked `sensitive` return PII (client/device MAC, IP and
// hostname) or network topology/security configuration and should be
// admin-gated by whatever wires this connector into a gateway.

type Scope = 'console' | 'site';

interface NetworkToolSpec {
  name: string;
  description: string;
  scope: Scope;
  /** Path under the Network API, with {siteId}/{deviceId}/{clientId} placeholders. */
  path: string;
  /** Extra required path IDs beyond consoleId/siteId. */
  ids?: Array<'deviceId' | 'clientId'>;
  paged?: boolean;
  filterable?: boolean;
  sensitive?: boolean;
}

const SPECS: NetworkToolSpec[] = [
  {
    name: 'unifi_network_get_info',
    description: 'Get general information about the UniFi Network application on a console, such as its version.',
    scope: 'console',
    path: '/v1/info',
  },
  {
    name: 'unifi_network_list_sites',
    description:
      'List the local Network sites on one console. The returned site IDs (UUIDs) are what every other unifi_network_* site tool needs; they differ from the cloud site IDs returned by unifi_list_sites.',
    scope: 'console',
    path: '/v1/sites',
    paged: true,
    filterable: true,
  },
  {
    name: 'unifi_network_list_pending_devices',
    description: 'List devices waiting to be adopted on one console.',
    scope: 'console',
    path: '/v1/pending-devices',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_list_devices',
    description:
      "List adopted devices on a site with name, model, MAC, IP, state and firmware. Filter example: state.eq('OFFLINE') or name.like('AP*'). PII-bearing - admin-gated.",
    scope: 'site',
    path: '/v1/sites/{siteId}/devices',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_get_device',
    description:
      'Get one adopted device in detail: firmware, uplink, features and interfaces (ports, radios). PII-bearing - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/devices/{deviceId}',
    ids: ['deviceId'],
    sensitive: true,
  },
  {
    name: 'unifi_network_get_device_statistics',
    description: "Get one adopted device's latest statistics: uptime, CPU and memory use, and data rates.",
    scope: 'site',
    path: '/v1/sites/{siteId}/devices/{deviceId}/statistics/latest',
    ids: ['deviceId'],
  },
  {
    name: 'unifi_network_list_clients',
    description:
      "List connected clients on a site (wired, wireless and VPN) with name, IP, MAC and connection type. Filter example: macAddress.eq('aa:bb:cc:dd:ee:ff') or access.type.eq('GUEST'). PII-bearing - admin-gated.",
    scope: 'site',
    path: '/v1/sites/{siteId}/clients',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_get_client',
    description: 'Get one connected client in detail. PII-bearing - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/clients/{clientId}',
    ids: ['clientId'],
    sensitive: true,
  },
  {
    name: 'unifi_network_list_wans',
    description: 'List the WAN interfaces defined on a site.',
    scope: 'site',
    path: '/v1/sites/{siteId}/wans',
    paged: true,
  },
  {
    name: 'unifi_network_list_vpn_tunnels',
    description: 'List site-to-site VPN tunnels on a site. Network topology - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/vpn/site-to-site-tunnels',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_list_vpn_servers',
    description: 'List VPN servers on a site. Network topology - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/vpn/servers',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_list_networks',
    description: 'List networks (VLANs, subnets, DHCP) on a site. Network topology - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/networks',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_list_wifi_broadcasts',
    description: 'List WiFi broadcasts (SSIDs) on a site and their settings. Network configuration - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/wifi/broadcasts',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_list_firewall_policies',
    description: 'List firewall policies on a site. Security configuration - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/firewall/policies',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_list_firewall_zones',
    description: 'List firewall zones on a site. Security configuration - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/firewall/zones',
    paged: true,
    filterable: true,
    sensitive: true,
  },
  {
    name: 'unifi_network_list_acl_rules',
    description: 'List ACL rules on a site. Security configuration - admin-gated.',
    scope: 'site',
    path: '/v1/sites/{siteId}/acl-rules',
    paged: true,
    filterable: true,
    sensitive: true,
  },
];

const COMMON_NOTE =
  ' Read-only; reached through the UniFi cloud connector, so the console must be online and on firmware 5.0.3 or later (100 requests/minute per console).';

function buildTool(spec: NetworkToolSpec): Tool {
  const properties: Record<string, object> = {
    consoleId: {
      type: 'string',
      description: 'Console (host) ID, as returned in hostId by unifi_list_sites or id by unifi_list_hosts.',
    },
  };
  const required = ['consoleId'];
  if (spec.scope === 'site') {
    properties.siteId = { type: 'string', description: 'Local Network site ID (UUID) from unifi_network_list_sites.' };
    required.push('siteId');
  }
  for (const id of spec.ids ?? []) {
    properties[id] = { type: 'string', description: `${id === 'deviceId' ? 'Device' : 'Client'} ID (UUID).` };
    required.push(id);
  }
  if (spec.paged) {
    properties.offset = { type: 'number', description: 'Number of items to skip (default 0).' };
    properties.limit = { type: 'number', description: 'Items per page, 0-200 (default 25).' };
  }
  if (spec.filterable) {
    properties.filter = {
      type: 'string',
      description: "UniFi filter expression, e.g. name.eq('x'), state.in('ONLINE','OFFLINE'), or(...), and(...).",
    };
  }
  return {
    name: spec.name,
    description: spec.description + COMMON_NOTE,
    inputSchema: { type: 'object', properties, required },
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
}

export const NETWORK_TOOLS: Tool[] = SPECS.map(buildTool);

/** Names of the tools that return PII or network/security configuration. */
export const SENSITIVE_NETWORK_TOOLS: ReadonlySet<string> = new Set(
  SPECS.filter((s) => s.sensitive).map((s) => s.name)
);

const SPEC_BY_NAME = new Map(SPECS.map((s) => [s.name, s]));
export function isNetworkTool(name: string): boolean {
  return SPEC_BY_NAME.has(name);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${key} is required`);
  }
  return v.trim();
}

export async function handleNetworkTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) return errorResult(`Unknown tool: ${name}`);

  const creds = getCredentials();
  const missing = requireCredentials(creds);
  if (missing) return missing;

  try {
    const consoleId = requireString(args, 'consoleId');
    let path = spec.path;
    const placeholders = spec.scope === 'site' ? ['siteId', ...(spec.ids ?? [])] : [];
    for (const key of placeholders) {
      path = path.replace(`{${key}}`, encodeURIComponent(requireString(args, key)));
    }

    const query: Record<string, unknown> = {};
    if (spec.paged) {
      if (args.offset !== undefined) query.offset = args.offset;
      if (args.limit !== undefined) query.limit = args.limit;
    }
    if (spec.filterable && typeof args.filter === 'string' && args.filter.trim() !== '') {
      query.filter = args.filter.trim();
    }

    return textResult(await networkGet(creds!, consoleId, path, query));
  } catch (err) {
    return errorResult((err as Error).message);
  }
}
