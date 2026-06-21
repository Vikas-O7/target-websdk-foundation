import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setupTargetWebsdk } from "../api/orchestration.js";

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

export function registerOrchestrationTools(server: McpServer) {
  // ── setup_target_websdk ─────────────────────────────────
  server.tool(
    "setup_target_websdk",
    "Full end-to-end setup wizard for a Target Web SDK implementation. Creates the datastream, adds Target (and optionally Analytics for A4T), creates a Tags property + host + all three environments, installs the Web SDK extension, creates all standard data elements + rules, builds the dev library, optionally runs full validation, and returns the dev embed code. Idempotent — re-running the same input picks up existing resources where possible. On failure at any step, partial progress is returned so you can fix the underlying cause and resume.",
    {
      // Datastream
      datastreamName: z.string().min(1),
      targetClientCode: z
        .string()
        .min(1)
        .describe(
          "Adobe Target client code, e.g. 'agsinternal'. Same value as ADOBE_TARGET_CLIENT_CODE."
        ),
      targetPropertyToken: z
        .string()
        .optional()
        .describe(
          "Optional at_property token for workspace isolation."
        ),
      includeA4t: z.boolean().default(false),
      reportSuites: z.array(z.string()).optional(),
      trackingServer: z.string().optional(),

      // Property
      propertyName: z.string().min(1),
      domains: z.array(z.string().min(1)).min(1),

      // Web SDK
      flickerStyle: z
        .string()
        .default("body { opacity: 0 !important }")
        .describe(
          "Raw CSS rule to prehide while Target loads. Default hides whole body (legacy v1.0 behavior). Prefer flickerSelectors for scoped prehiding — the senior-consultant best practice."
        ),
      flickerSelectors: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "v1.1 — preferred prehiding scope. CSS selectors to hide while Target loads (e.g. ['#hero', '.product-card', '.checkout-cta']). When set, takes precedence over flickerStyle. Scopes prehiding to just these containers, avoiding the whole-body blank-page failure mode."
        ),
      consentMode: z
        .enum(["in", "pending"])
        .default("in")
        .describe(
          "v1.1 — Web SDK consent default. 'in' = SDK fires Target calls immediately (default, US-safe). 'pending' = SDK waits for explicit consent grant via a Set Consent action; required for EU/UK GDPR compliance. When 'pending', wire your CMP (OneTrust / Cookiebot / Adobe Consent / etc.) to dispatch the consent grant — see docs/consent-management.md."
        ),

      // Data elements
      pageNamePath: z
        .string()
        .default("digitalData.page.pageInfo.pageName"),
      crmIdPath: z
        .string()
        .default("digitalData.user[0].profile[0].profileInfo.profileID"),
      includeOrderDes: z.boolean().default(false),

      // Rules
      renderDecisions: z.boolean().default(true),
      includeOrderRule: z.boolean().default(false),
      orderPagePath: z.string().default("/order-confirmation"),

      // Library
      libraryName: z.string().optional(),

      // Validation
      runValidation: z.boolean().default(true),
    },
    async (input) => {
      try {
        const result = await setupTargetWebsdk(input);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
