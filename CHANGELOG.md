# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

Per-version release notes for tagged releases are published on the [GitHub Releases page](https://github.com/WYRE-AI/unifi-mcp/releases) - `semantic-release` generates them from commit history at release time.

## [Unreleased]

### Added

- 16 read-only `unifi_network_*` tools for a console's local UniFi Network API, reached through the Site Manager connector proxy with the same UI.com API key: Network application info, local sites, pending and adopted devices, device details and latest statistics, connected clients, WANs, VPN tunnels and servers, networks, WiFi broadcasts, firewall policies and zones, and ACL rules. Each tool sends `GET` to one fixed path, with IDs URL-encoded; there is no free-form path and no mutating verb. Client, device and configuration tools are listed in `SENSITIVE_NETWORK_TOOLS` for admin-gating. Requires console firmware 5.0.3 or later; the connector allows 100 requests per minute per console.
- Initial v1 release: 9 read-only tools covering every dedicated read operation on the UniFi Cloud Site Manager API (sites, hosts, devices, ISP/WAN metrics, SD-WAN configs and status). Static `X-API-Key` authentication against a UI.com account - no OAuth. Deliberately targets the Cloud Site Manager API only; the local per-controller Network API (client-level detail, VLANs/WLANs/firewall rules, which the cloud API does not expose as dedicated operations) is out of scope for this connector by design. The live spec (`developer.ui.com/site-manager/v1.0.0/openapi.json`, fetched directly) defines a 10th path, `/v1/connector/consoles/{id}/*path` - a generic reverse-proxy into a console's local API, documented as accepting GET/POST/PUT/PATCH/DELETE - which this connector's code deliberately never calls (structurally verified: no such call exists anywhere in `src/`). Whether UI.com's backend actually enforces "read-only" server-side against that path is a separate, unverified claim - WYRE has not tested a write call against it. See README's Scope and Authentication sections for the full two-tier explanation.
