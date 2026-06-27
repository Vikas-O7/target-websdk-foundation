/**
 * Vercel serverless function entry — MCP over Streamable HTTP.
 *
 * Vercel routes `*.ts` files under /api/ to serverless functions. This
 * file is the bridge between Vercel's request lifecycle and the
 * transport-agnostic handler in src/index-http.ts.
 *
 * Deployment notes:
 *   - This file MUST stay at /api/mcp.ts (Vercel's convention)
 *   - The deployed URL becomes https://<project>.vercel.app/api/mcp
 *   - vercel.json includes a rewrite so /mcp also reaches this function
 *     (matches the path the SDK examples + ecosystem assume)
 *   - Stateless by design — Vercel functions are ephemeral
 *   - Set MCP_TRANSPORT=http in Vercel env so config.ts skips its
 *     stdio-mode env validation at boot
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHttpRequest } from "../build/index-http.js";

// Vercel's Node runtime hands us Express-style req/res that are
// compatible with Node's http types. req.body is parsed automatically
// when Content-Type: application/json.
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse
): Promise<void> {
  try {
    await handleHttpRequest(req, res, req.body);
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
}

// Vercel config — extend timeout for slow Adobe API calls (library
// builds can take 30+s, full validation 60+s).
export const config = {
  runtime: "nodejs20.x",
  maxDuration: 300,
};
