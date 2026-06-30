/**
 * HTTP entry point — Streamable HTTP transport for hosted deployments.
 *
 * Spawned per-request in serverless environments (Vercel, Cloudflare,
 * Lambda) or as a long-running process locally via `npm run dev:http`.
 *
 * Each request:
 *   1. Extracts Adobe credentials from custom HTTP headers
 *      (X-Adobe-Client-Id, X-Adobe-Client-Secret, etc.)
 *   2. Wraps the request handling in AsyncLocalStorage so existing
 *      stdio-mode code (config, IMS auth, API clients) transparently
 *      reads per-tenant credentials with no parameter threading.
 *   3. Spins up a fresh MCP server with all 22 tools registered
 *      and a stateless Streamable HTTP transport.
 *   4. Delegates to the transport to handle the JSON-RPC protocol.
 *
 * Multi-tenancy isolation:
 *   - IMS token cache (auth/adobe-ims.ts) keyed by client_id
 *   - Reactor company-ID cache (api/reactor-client.ts) keyed by org_id
 *   - All other state is per-request (server + transport instances)
 *
 * Why stateless: serverless functions are ephemeral. The MCP Streamable
 * HTTP spec supports stateless operation (`sessionIdGenerator: undefined`)
 * — see https://modelcontextprotocol.io/docs/concepts/transports.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  configFromHeaders,
  runWithRequestConfig,
  HTTP_HEADER_NAMES,
} from "./request-context.js";

import { registerDatastreamTools } from "./tools/datastream-tools.js";
import { registerSetupTools } from "./tools/setup-tools.js";
import { registerLibraryTools } from "./tools/library-tools.js";
import { registerValidationTools } from "./tools/validation-tools.js";
import { registerOrchestrationTools } from "./tools/orchestration-tools.js";
import { registerDiscoveryTools } from "./tools/discovery-tools.js";
import { registerArchetypeTools } from "./tools/archetype-tools.js";
import { registerCatalogSyncTools } from "./tools/catalog-sync-tools.js";
import { registerAtjsAnalysisTools } from "./tools/atjs-analysis-tools.js";

const VERSION = "1.4.0";
const SERVER_NAME = "target-websdk-foundation";

// ── Per-request MCP server factory ──────────────────────────
function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  registerDatastreamTools(server);
  registerSetupTools(server);
  registerLibraryTools(server);
  registerValidationTools(server);
  registerOrchestrationTools(server);
  registerDiscoveryTools(server);
  registerArchetypeTools(server);
  registerCatalogSyncTools(server);
  registerAtjsAnalysisTools(server);
  return server;
}

// ── Public request handler ──────────────────────────────────
/**
 * Handles one MCP request lifecycle. Accepts Node-style req/res (works
 * with Vercel, Express, or raw http.Server). Body should be the parsed
 * JSON-RPC payload.
 *
 * Behavior:
 *   - GET / or GET /health  → JSON banner (no auth required)
 *   - POST /mcp             → MCP JSON-RPC (auth required via headers)
 *   - everything else       → 404
 */
export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // ── Health / banner endpoints (no auth) ──
  if (method === "GET" && (url === "/" || url.startsWith("/health"))) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        name: SERVER_NAME,
        version: VERSION,
        transport: "streamable-http",
        tools_count: 28,
        docs: "https://github.com/Vikas-O7/target-websdk-foundation",
        required_headers: Object.values(HTTP_HEADER_NAMES),
      })
    );
    return;
  }

  // ── MCP endpoint ──
  if (method === "POST" && url.startsWith("/mcp")) {
    // 1. Authenticate from headers
    const auth = configFromHeaders(
      req.headers as Record<string, string | string[] | undefined>
    );
    if (!auth.ok) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "missing_or_invalid_credentials",
          missing_headers: auth.missing,
          help: "Add the missing headers to your MCP server config. See https://github.com/Vikas-O7/target-websdk-foundation#cx-coworker-setup",
        })
      );
      return;
    }

    // 2. Run inside the tenant's request-config scope so config.X reads
    //    return this tenant's credentials throughout the call tree.
    await runWithRequestConfig(auth.config, async () => {
      const server = buildServer();
      // Stateless mode: serverless functions don't share state across
      // invocations, so we can't maintain session state anyway.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      try {
        await transport.handleRequest(req, res, body);
      } finally {
        // Best-effort cleanup. The transport owns the response lifecycle;
        // we just release our handle.
        try {
          await transport.close();
        } catch {
          /* ignore close errors after response sent */
        }
      }
    });
    return;
  }

  // ── Unknown route ──
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      error: "not_found",
      message: `${method} ${url} — try POST /mcp`,
    })
  );
}

// ── Local dev server (only when invoked directly) ───────────
//
// `node build/index-http.js` starts a local HTTP server on port 3000
// for end-to-end testing before deploying to Vercel. Vercel itself
// never executes this entry — it wires the request to api/mcp.ts.
async function runLocalDevServer(): Promise<void> {
  const { createServer } = await import("node:http");
  const port = Number(process.env.PORT ?? 3000);

  const httpServer = createServer((req, res) => {
    // Buffer the body for POST requests
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = undefined;
        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "invalid_json" }));
            return;
          }
        }
        try {
          await handleHttpRequest(req, res, parsed);
        } catch (e) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: "internal_error",
                detail: (e as Error).message,
              })
            );
          }
        }
      });
    } else {
      void handleHttpRequest(req, res).catch((e) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end((e as Error).message);
        }
      });
    }
  });

  httpServer.listen(port, () => {
    console.error("═══════════════════════════════════════════════════════");
    console.error(`  Target Web SDK Foundation v${VERSION} — HTTP mode`);
    console.error(`  28 tools registered across 9 tool groups`);
    console.error(`  Listening on http://localhost:${port}`);
    console.error(`  Health:  GET  http://localhost:${port}/health`);
    console.error(`  MCP:     POST http://localhost:${port}/mcp`);
    console.error("═══════════════════════════════════════════════════════");
  });
}

// Run local dev server when MCP_TRANSPORT=http AND this module is the
// process entry point. On Vercel, api/mcp.ts imports `handleHttpRequest`
// directly — it never executes the local dev branch because (a) Vercel
// sets MCP_TRANSPORT=http but (b) the entry is api/mcp.ts, not this file.
//
// The fileURLToPath comparison is the Node-canonical way to detect "am
// I the entry point", robust to Windows backslash vs forward-slash paths.
import { fileURLToPath } from "node:url";
const thisFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? "";
const isDirectInvocation = thisFile === entryFile;

if (isDirectInvocation) {
  void runLocalDevServer();
}
