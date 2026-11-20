import { createServer as createHttpServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { runWithCredentials } from './client.js';
import { logger } from './utils/logger.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';

/**
 * HTTP transport fails closed (CWE-306).
 *
 * An empty CONDUIT_S2S_SECRET used to skip the X-Gateway-S2S check. Startup
 * now refuses to listen unless the secret is set and is not a known
 * placeholder. MCP_ALLOW_INSECURE_DEV=1 is the only bypass for an empty
 * secret: it logs a warning, does not enforce S2S, and binds 127.0.0.1
 * even when MCP_HTTP_HOST is a wider address. A known placeholder is never
 * accepted, including when that flag is set.
 *
 * A real secret honors MCP_HTTP_HOST. When that variable is unset the
 * process keeps the historical 0.0.0.0 bind. The secret value is never logged.
 *
 * Gateway mode requires X-UniFi-Api-Key on every /mcp request and does not
 * fall back to UNIFI_API_KEY. /health and /healthz stay unauthenticated and
 * do not read credentials. The stdio transport does not use S2S auth.
 */

/** Public example values. A copied placeholder must not verify as a real secret. */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

const LOOPBACK_HOST = '127.0.0.1';

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. ' +
  'Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), ' +
  'or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. ' +
  'Local development only; do not expose this port.';

function refuseStart(message: string): never {
  logger.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 127.0.0.1, the rest of 127.0.0.0/8, localhost, and ::1. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const bare = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  const parts = bare.split('.');
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === '127';
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 */
function resolveS2sSecret(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.CONDUIT_S2S_SECRET ?? '').trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return raw;
  if (env.MCP_ALLOW_INSECURE_DEV === '1') return '';
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret: force 127.0.0.1. A non-loopback MCP_HTTP_HOST is ignored
 * and the override is logged. A real secret honors MCP_HTTP_HOST; unset
 * stays 0.0.0.0 so existing container deploys keep their bind.
 */
function resolveBindHost(s2sSecret: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MCP_HTTP_HOST ?? '').trim();
  if (s2sSecret) return configured || '0.0.0.0';
  if (configured && !isLoopbackBindHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        'MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. ' +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

export async function startHttpTransport(): Promise<Server> {
  const s2sSecret = resolveS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = resolveBindHost(s2sSecret);
  const insecureDev = !s2sSecret;
  if (insecureDev) {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
  }
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    // Only the path is used, so parse against a fixed base rather than the
    // client-supplied Host header. A target that still cannot be parsed (e.g. "//")
    // must answer 400, never throw out of the listener.
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }

    // /health is container LIVENESS, not credential-readiness. In gateway
    // mode, credentials arrive per-request via X-UniFi-Api-Key, not at
    // startup. Always 200, no auth, and this handler must not read
    // vendor credentials (doing so would also leak whether UNIFI_API_KEY
    // is set in the process environment).
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          transport: 'http',
          mode: isGatewayMode ? 'gateway' : 'standalone',
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health', '/healthz'] }));
      return;
    }

    // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1; startup
    // refuses otherwise. A configured secret is always enforced, before any
    // credential extraction.
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
        }),
      );
      return;
    }

    const handle = async () => {
      // SECURITY-CRITICAL invariant: this transport MUST stay stateless
      // (sessionIdGenerator: undefined + enableJsonResponse: true).
      // Per-request tenant credentials are carried in an AsyncLocalStorage
      // context opened by runWithCredentials() below. A stateless
      // request->single-response flow keeps the tool call inside that
      // context - switching to a stateful/SSE transport would let a
      // long-lived connection serve later messages under a stale/foreign
      // credential context.
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    };

    // Gateway mode: the API key must arrive on every request via
    // X-UniFi-Api-Key. Reject explicitly if it is missing rather than
    // falling through — falling through would resolve UNIFI_API_KEY from
    // the process environment, which is not request-scoped.
    if (isGatewayMode) {
      const apiKey = headerValue(req.headers['x-unifi-api-key']);
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Missing credentials. Gateway must inject X-UniFi-Api-Key header.',
          }),
        );
        return;
      }

      await runWithCredentials({ apiKey }, handle);
      return;
    }

    await handle();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      logger.info(`HTTP streaming server listening on ${host}:${port}`);
      resolve();
    });
  });

  return httpServer;
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/http.js` still starts HTTP or falls through
// to stdio, matching the previous module-load behavior.
if (process.env.VITEST !== 'true') {
  const transport = process.env.MCP_TRANSPORT;
  if (transport === 'http') {
    startHttpTransport().catch((error) => {
      logger.error('Fatal startup error', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  } else {
    import('./index.js');
  }
}
