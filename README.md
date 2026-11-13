# UniFi MCP Server

MCP server for [Ubiquiti UniFi](https://www.ui.com/)'s **Cloud Site Manager API** - sites, hosts, devices, WAN/ISP health metrics, SD-WAN configuration/status, and read-only per-console Network detail (devices, clients, networks, firewall) through the cloud connector - for AI assistants and the WYRE Conduit gateway.

## Scope: Cloud Site Manager API, plus read-only Network API through the cloud connector

UniFi exposes two distinct API surfaces:

- **Cloud Site Manager API** (`developer.ui.com/site-manager/...`, base URL `https://api.ui.com`) - a single UI.com account key that aggregates data across every site adopted to that account, with a narrow read surface: sites, hosts, device inventory, WAN/ISP metrics, and SD-WAN config/status.
- **Local Network application API** (`developer.ui.com/network/...`) - lives on each console and covers per-site detail: individual devices and their statistics, connected clients, networks/VLANs, WiFi broadcasts, firewall policies and zones, ACL rules, VPN, and more.

This connector implements all 9 dedicated read operations of the Cloud Site Manager API. It also reaches a **fixed, read-only subset** of each console's Network API through the Site Manager's connector-proxy endpoint, using the same UI.com API key - see [The connector-proxy endpoint](#the-connector-proxy-endpoint-read-only-fixed-paths) below.

## Authentication

UniFi Site Manager authenticates with a single **static `X-API-Key` header** tied to a UI.com account - there is no OAuth flow, no token exchange, and no per-request expiry. Generate a key at `unifi.ui.com` under **Settings > API Keys**.

Two separate claims here, at deliberately different confidence levels - don't collapse them into one "read-only" statement:

- **Structurally verified (checked directly, stated with full confidence):** this connector's own code makes zero mutating calls. The only non-`GET` request is `unifi_query_isp_metrics`, a `POST` that is a filtered read. Every connector-proxy request is a `GET` to a fixed path built in `src/tools/network.ts`; `networkGet` in `client.ts` only sends `GET`, and no tool accepts a free-form path. A unit test asserts every `unifi_network_*` tool sends `GET`.
- **Vendor-documented, not independently verified (hedged deliberately):** Ubiquiti's own Getting Started documentation describes Site Manager API keys generally as read-only ("currently read-only... cannot be used to make modifications to your UniFi infrastructure"). The connector-proxy endpoint is nevertheless documented as accepting `POST`/`PUT`/`PATCH`/`DELETE`, and whether UI.com's backend rejects those has not been tested. **Do not read this connector, or this README, as having established that the underlying API key cannot perform writes** - only that this connector's own code never attempts one.

In gateway mode the key arrives per-request via the `X-UniFi-Api-Key` header; in local/stdio mode it's read once from `UNIFI_API_KEY`. HTTP mode also requires a signed `X-Gateway-S2S` header — see Configuration.

### The connector-proxy endpoint (read-only, fixed paths)

The Site Manager spec (`https://developer.ui.com/site-manager/v1.0.0/openapi.json`) defines `/v1/connector/consoles/{id}/*path`, a reverse-proxy that forwards a request to the console's local API at `http://127.0.0.1/proxy/[path]`. It reaches the console's whole local Network/Protect/InnerSpace surface and accepts all five HTTP methods.

This connector does **not** expose it as a wildcard passthrough. The `unifi_network_*` tools each call one fixed `GET` path on the Network API (`/network/integration/v1/...`), with IDs URL-encoded so they cannot change the path. Limits from the spec:

- The console must be online and on firmware 5.0.3 or later.
- A standard API key reaches only consoles the key's owner controls; an organization key reaches any console in the organization.
- 100 requests per minute per console, a 25-second upstream timeout, and a 10 MB response cap.

The Network spec's server URL is `/v1/connector/consoles/{id}/proxy/network/integration`, while the connector's own example omits `/proxy/`. `networkGet` tries the spec's form first and retries once without `/proxy/` only on HTTP 404.

## Configuration

Copy [`.env.example`](.env.example) and set the variables below.

| Env var | Required | Description |
|---|---|---|
| `UNIFI_API_KEY` | For stdio and `AUTH_MODE=env` | UniFi Cloud Site Manager API key (`X-API-Key`). |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http`. |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose) or `env`. Gateway mode requires `X-UniFi-Api-Key` on each `/mcp` request and never falls back to `UNIFI_API_KEY`. `env` uses that variable only after S2S auth succeeds. Unset means `env` (stdio and single-tenant HTTP). |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `secret`, `replace-me`, `your-s2s-secret`, and the other example values). Generate one with `openssl rand -hex 32`. Compose will not start without it. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` is overridden and logged. A known placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset keeps `0.0.0.0`, the historical bind. The image and Compose set `0.0.0.0` inside the container. With no secret, the listener is `127.0.0.1` regardless of this value. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `LOG_LEVEL` | No | `debug` \| `info` (default) \| `warn` \| `error`. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before the UniFi API key is read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-UniFi-Api-Key: $UNIFI_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-UniFi-Api-Key`. That header is the only credential source for that request. `AUTH_MODE=env` still requires the signed `X-Gateway-S2S` header, then uses `UNIFI_API_KEY` from the environment.

## Tools

9 read-only tools for the Cloud Site Manager API, plus 16 read-only `unifi_network_*` tools for a console's local Network API through the connector proxy (see Authentication above).

### Sites
- `unifi_list_sites` - list every site visible to this API key's account, with metadata (name, timezone, gateway MAC) and aggregate statistics (device/client counts, network performance).

### Hosts
- `unifi_list_hosts` - list every host (console / network-server application) associated with this API key's account.
- `unifi_get_host` - get detailed information about a single host by ID.

### Devices
- `unifi_list_devices` - list UniFi devices managed by hosts this account owns or super-admins, grouped by host. **PII-bearing** (MAC address, IP address, user-defined hostname/note per device) - **admin-gated by default**.

### WAN / ISP Health
- `unifi_get_isp_metrics` - WAN/ISP health and traffic metrics for every linked site, at 5-minute or 1-hour granularity.
- `unifi_query_isp_metrics` - the same metrics, scoped to specific host/site pairs and time ranges. A `POST` on UniFi's API, but a filtered read, not a mutation.

### SD-WAN
- `unifi_list_sdwan_configs` - list every SD-WAN configuration (id/name/type only).
- `unifi_get_sdwan_config` - full topology for one SD-WAN configuration: hub/spoke sites, attached networks, and routed subnets (CIDR). **Network-topology data - admin-gated by default**.
- `unifi_get_sdwan_config_status` - deployment status for one SD-WAN configuration, including per-hub/spoke WAN IPs and latency. **Network-topology data - admin-gated by default**.

### Network application (per console, via the connector proxy)

Every tool takes `consoleId` (the host ID from `unifi_list_sites` or `unifi_list_hosts`). Site-level tools also take `siteId`, the console's **local** site UUID from `unifi_network_list_sites` - not the cloud site ID. List tools accept `offset` and `limit` (max 200), and most accept a UniFi `filter` expression such as `state.eq('OFFLINE')`.

- `unifi_network_get_info` - Network application version and info.
- `unifi_network_list_sites` - local sites on the console.
- `unifi_network_list_pending_devices` - devices waiting for adoption. **Admin-gated.**
- `unifi_network_list_devices` / `unifi_network_get_device` - adopted devices with name, model, MAC, IP, state, firmware, uplink and ports. **PII-bearing - admin-gated.**
- `unifi_network_get_device_statistics` - latest uptime, CPU, memory and data rates for one device.
- `unifi_network_list_clients` / `unifi_network_get_client` - connected clients (wired, wireless, VPN). **PII-bearing - admin-gated.**
- `unifi_network_list_wans` - WAN interfaces on a site.
- `unifi_network_list_vpn_tunnels` / `unifi_network_list_vpn_servers` - site-to-site tunnels and VPN servers. **Topology - admin-gated.**
- `unifi_network_list_networks` / `unifi_network_list_wifi_broadcasts` - networks/VLANs and SSIDs. **Configuration - admin-gated.**
- `unifi_network_list_firewall_policies` / `unifi_network_list_firewall_zones` / `unifi_network_list_acl_rules` - security configuration. **Admin-gated.**

`SENSITIVE_NETWORK_TOOLS` in `src/tools/network.ts` lists the admin-gated `unifi_network_*` tools for gateway wiring.

Among the cloud tools, `unifi_list_sites`, `unifi_list_hosts`, `unifi_get_host`, `unifi_get_isp_metrics`, `unifi_query_isp_metrics`, and `unifi_list_sdwan_configs` are plain-read tier: sites/hosts are the navigational directory most other tools need site/host IDs from, and WAN metrics are aggregate performance data, not PII or topology.

## Sensitivity

This connector's tools surface two categories of sensitive data even though every one of them is read-only: **PII** (MAC addresses, IP addresses and hostnames of devices and clients) and **network topology and security configuration** (SD-WAN routes and subnets, networks, SSIDs, VPN, firewall and ACL rules). `unifi_list_devices`, `unifi_get_sdwan_config`, `unifi_get_sdwan_config_status` and the `unifi_network_*` tools in `SENSITIVE_NETWORK_TOOLS` should default to `isAdmin: true` in the gateway wiring; everything else is plain read.

## Development

```bash
npm install
npm run build
npm test
npm run lint   # tsc --noEmit
```

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass a real S2S secret. In gateway mode, the UniFi API key arrives on each request as `X-UniFi-Api-Key`; it is not read from the environment.

```bash
docker build -t unifi-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  unifi-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset. The gateway service sets `AUTH_MODE=gateway`, does not inject `UNIFI_API_KEY`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `UNIFI_API_KEY`. It is separate from the gateway Compose service above.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e UNIFI_API_KEY=your-value \
  -p 127.0.0.1:8080:8080 \
  unifi-mcp
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is overridden:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

## License

Apache-2.0
