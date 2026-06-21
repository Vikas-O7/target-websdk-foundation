import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { discoverSite } from "../api/discovery.js";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(error: unknown) {
  return {
    content: [
      { type: "text" as const, text: `Error: ${(error as Error).message}` },
    ],
    isError: true,
  };
}

export function registerDiscoveryTools(server: McpServer) {
  // ── discover_site ──────────────────────────────────────────
  server.tool(
    "discover_site",
    "Static fingerprint a website URL before calling setup_target_websdk. Fetches the served HTML and sniffs for: existing Tags/alloy/at.js/DTM/GTM implementations, data layer flavor (CEDDL/ACDL/GTM/Tealium/none), framework (React/Next/Vue/Angular/Svelte/vanilla), CMP vendor (OneTrust/Cookiebot/Adobe Consent/Iubenda/TrustArc/Didomi/IAB TCF/none), and page-type heuristic. Returns a discovery report + a recommended_setup config block ready to thread into setup_target_websdk. v1.1 uses static fetch only — does NOT execute JavaScript, so SPAs that inject data layer after first paint may look empty. Chrome MCP integration deferred to v1.2.",
    {
      websiteUrl: z
        .string()
        .url()
        .describe(
          "Full URL to fingerprint. Use a representative page — for ecommerce, a PDP works better than the homepage (more signals in the served HTML)."
        ),
    },
    async ({ websiteUrl }) => {
      try {
        const result = await discoverSite(websiteUrl);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
