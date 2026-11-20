# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

Per-version release notes for tagged releases are published on the [GitHub Releases page](https://github.com/WYRE-AI/unifi-mcp/releases) - `semantic-release` generates them from commit history at release time.

## [Unreleased]

### Fixed

- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

### Added

- Initial v1 release: 9 read-only tools covering every dedicated read operation on the UniFi Cloud Site Manager API (sites, hosts, devices, ISP/WAN metrics, SD-WAN configs and status). Static `X-API-Key` authentication against a UI.com account - no OAuth. Deliberately targets the Cloud Site Manager API only; the local per-controller Network API (client-level detail, VLANs/WLANs/firewall rules, which the cloud API does not expose as dedicated operations) is out of scope for this connector by design. The live spec (`developer.ui.com/site-manager/v1.0.0/openapi.json`, fetched directly) defines a 10th path, `/v1/connector/consoles/{id}/*path` - a generic reverse-proxy into a console's local API, documented as accepting GET/POST/PUT/PATCH/DELETE - which this connector's code deliberately never calls (structurally verified: no such call exists anywhere in `src/`). Whether UI.com's backend actually enforces "read-only" server-side against that path is a separate, unverified claim - WYRE has not tested a write call against it. See README's Scope and Authentication sections for the full two-tier explanation.
