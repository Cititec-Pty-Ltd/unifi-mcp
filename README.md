> **Cititec fork** of [WYRE-AI/unifi-mcp](https://github.com/WYRE-AI/unifi-mcp). Before changing anything, read
> [CITITEC-FORK.md](CITITEC-FORK.md): which changes go back to Wyre and which stay in this fork.

# UniFi MCP Server

MCP server for [Ubiquiti UniFi](https://www.ui.com/)'s **Cloud Site Manager API** - sites, hosts, devices, WAN/ISP health metrics, and SD-WAN configuration/status, for AI assistants and the WYRE Conduit gateway.

## Scope: Cloud Site Manager API only (deliberate)

UniFi exposes two distinct API surfaces:

- **Local per-controller API** (Network Application API, `developer.ui.com/network/...`) - lives on each customer's own console/controller, requires a separate API key per site with no central integration point, and covers per-site configuration in depth: clients, networks/VLANs/DHCP, WLANs/SSIDs, firewall rules, port forwarding, etc.
- **Cloud Site Manager API** (`developer.ui.com/site-manager/...`, base URL `https://api.ui.com`) - a single UI.com account key that aggregates data across every site adopted to that account, but exposes a **much narrower** read surface: sites, hosts, device inventory, WAN/ISP metrics, and SD-WAN config/status only.

**This connector targets the Cloud Site Manager API only**, per an explicit upstream scope decision - the local per-controller API is deferred, not implemented as a fallback.

**Consequence for tool coverage:** the Cloud Site Manager API does **not** expose several things a "typical" network-management connector would have - there is no client-listing/client-detail endpoint (only aggregate client *counts* inside a site's `statistics`), no VLAN/network/DHCP-config endpoint, no WLAN/SSID endpoint, and no firewall-rule endpoint as first-class operations. Those all live on the local per-controller API. This connector implements 9 of the 10 paths the Cloud Site Manager API's own published OpenAPI spec defines as dedicated, purpose-built read operations - see Tools below. The 10th path is the connector-proxy endpoint, covered in its own subsection below - it is excluded by design, not missed.

## Authentication

UniFi Site Manager authenticates with a single **static `X-API-Key` header** tied to a UI.com account - there is no OAuth flow, no token exchange, and no per-request expiry. Generate a key at `unifi.ui.com` under **Settings > API Keys**.

Two separate claims here, at deliberately different confidence levels - don't collapse them into one "read-only" statement:

- **Structurally verified (checked directly, stated with full confidence):** this connector's own code makes zero mutating calls. Every function in `client.ts` calls one of the 9 dedicated read operations below; no `POST`/`PUT`/`PATCH`/`DELETE` call exists anywhere in `src/`, and the connector-proxy path (below) is never referenced under any name.
- **Vendor-documented, not independently verified (hedged deliberately):** Ubiquiti's own Getting Started documentation describes Site Manager API keys generally as read-only ("currently read-only... cannot be used to make modifications to your UniFi infrastructure"). Whether that's actually enforced *server-side* against the connector-proxy path specifically - i.e. whether UI.com's backend rejects a write verb sent through `/v1/connector/consoles/{id}/*path`, versus the restriction being a documented policy rather than a hard technical block - has not been tested by WYRE. Nobody on this review sent a write verb against a live key to find out, correctly: that would be a destructive test against real customer infrastructure, not something to run without consent. **Do not read this connector, or this README, as having established that the underlying API key cannot perform writes** - only that this connector's own code never attempts one.

In gateway mode the key arrives per-request via the `X-UniFi-Api-Key` header; in local/stdio mode it's read once from `UNIFI_API_KEY`. HTTP mode also requires a signed `X-Gateway-S2S` header — see Configuration.

### The connector-proxy endpoint (excluded by design)

The live spec (`https://developer.ui.com/site-manager/v1.0.0/openapi.json` - fetched directly with a plain `curl`/HTTP GET; this specific raw-JSON endpoint returns cleanly even though the *interactive docs pages* at `developer.ui.com` are a JS SPA that doesn't render via plain fetch) defines a 10th path beyond the 9 this connector implements: `/v1/connector/consoles/{id}/*path`, with all five HTTP methods - `GET`/`POST`/`PUT`/`PATCH`/`DELETE` (operationIds `ConnectorGet`/`ConnectorPost`/`ConnectorPut`/`ConnectorPatch`/`ConnectorDelete`). It is a generic reverse-proxy: `api.ui.com` forwards the request verbatim to the target console's local API at `http://127.0.0.1/proxy/[path]`, reaching the console's full local Network/Protect/InnerSpace surface - the same local per-controller API this connector's Scope section defers, just reached through the cloud endpoint instead of the console directly. The spec documents it as genuinely mutating - its own example for `DELETE` removes hotspot vouchers - and available to a **standard (non-organization) API key**, scoped to consoles that key's owner controls; it is not gated behind an org-tier key. (WYRE has not sent a live write call against this path - see the hedge in Authentication above.)

This connector deliberately excludes the connector-proxy endpoint entirely, for the same reason the local per-controller API is out of scope: implementing it would mean re-exposing the whole local surface (clients, VLANs, WLANs, firewall rules, and genuine mutations) through one wildcard passthrough tool, defeating the purpose of scoping this connector to purpose-built cloud reads. No tool in this connector calls it, under any name.

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

9 read-only tools, one per dedicated read operation in the Cloud Site Manager API's published spec (10 paths total on the live spec; the 10th, a generic mutating connector-proxy endpoint, is excluded by design - see Authentication above).

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

`unifi_list_sites`, `unifi_list_hosts`, `unifi_get_host`, `unifi_get_isp_metrics`, `unifi_query_isp_metrics`, and `unifi_list_sdwan_configs` are plain-read tier: sites/hosts are the navigational directory most other tools need site/host IDs from, and WAN metrics are aggregate performance data, not PII or topology.

## Sensitivity

This connector's own 9 tools surface two categories of sensitive data even though every one of them is read-only: **PII** (device MAC addresses, IP addresses, user-defined hostnames on every device returned by `unifi_list_devices`) and **network topology** (SD-WAN hub/spoke routes and subnets in `unifi_get_sdwan_config`/`unifi_get_sdwan_config_status`). Those three tools default to `isAdmin: true` in the Conduit wiring; everything else is plain read. This is separate from, and does not account for, the connector-proxy endpoint described under Authentication - that endpoint isn't implemented here at all, so it isn't part of this connector's tier model.

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
