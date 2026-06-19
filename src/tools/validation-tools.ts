import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  validateDatastream,
  validateTagsProperty,
  testEdgeNetwork,
  checkWebsiteImplementation,
  runFullValidation,
} from "../api/validation.js";

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

export function registerValidationTools(server: McpServer) {
  // ── validate_datastream ─────────────────────────────────
  server.tool(
    "validate_datastream",
    "Validate that a datastream is correctly configured for Adobe Target. Structural check via Platform API (no live traffic). Verifies the Target service is present + enabled, client code is set, and A4T settings are internally consistent.",
    { datastreamId: z.string().min(1) },
    async ({ datastreamId }) => {
      try {
        const result = await validateDatastream(datastreamId);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── validate_tags_property ──────────────────────────────
  server.tool(
    "validate_tags_property",
    "Validate a Tags property has all required components for Target Web SDK: Web SDK extension installed with datastream configured, required data elements, a page load Send Event rule with renderDecisions, and a development library. Optionally cross-checks the datastream ID embedded in the Web SDK settings.",
    {
      propertyId: z.string().min(1),
      expectedDatastreamId: z
        .string()
        .optional()
        .describe(
          "If provided, asserts the Web SDK extension is wired to this datastream."
        ),
    },
    async ({ propertyId, expectedDatastreamId }) => {
      try {
        const result = await validateTagsProperty(
          propertyId,
          expectedDatastreamId
        );
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── test_edge_network ───────────────────────────────────
  server.tool(
    "test_edge_network",
    "Send a live test event to the Adobe Edge Network using the provided datastream ID and verify that Target responds. This is a REAL network call from the MCP — no browser required, no auth headers. It proves the datastream → Target connection is alive. Note: target_has_activities=false is NORMAL unless an active activity targets the test URL — what matters is that target_responding=true. If you just created the datastream or added/changed services on it, pass waitForPropagationSeconds: 90 — Edge Network takes ~30-60s to sync.",
    {
      datastreamId: z.string().min(1),
      testPageName: z.string().default("MCP Validation Test"),
      testUrl: z.string().url().default("https://mcp-validation.local"),
      waitForPropagationSeconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .default(0)
        .describe(
          "Max seconds to wait for Edge propagation. Only kicks in when the datastream is otherwise healthy but Target hasn't started responding yet. Set to 90 after creating a new datastream or adding the Target service. Default 0 (no waiting)."
        ),
      pollIntervalSeconds: z
        .number()
        .int()
        .min(5)
        .max(60)
        .default(15)
        .describe(
          "Seconds between propagation retries. Default 15. Lower = faster detection but more API calls."
        ),
    },
    async ({
      datastreamId,
      testPageName,
      testUrl,
      waitForPropagationSeconds,
      pollIntervalSeconds,
    }) => {
      try {
        const result = await testEdgeNetwork(datastreamId, testPageName, testUrl, {
          waitForPropagationSeconds,
          pollIntervalSeconds,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── check_website_implementation ────────────────────────
  server.tool(
    "check_website_implementation",
    "Fetch a public website URL and check whether the Tags embed script is present in the served HTML. No browser execution — raw HTML scrape with regex. Also flags at.js / legacy Visitor API conflicts, ACDL presence, and whether the embed is async.",
    {
      websiteUrl: z.string().url(),
      expectedScriptUrl: z
        .string()
        .optional()
        .describe(
          "Expected Tags script URL from get_embed_code. If provided, verifies the deployed script matches."
        ),
    },
    async ({ websiteUrl, expectedScriptUrl }) => {
      try {
        const result = await checkWebsiteImplementation(
          websiteUrl,
          expectedScriptUrl
        );
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── run_full_validation ─────────────────────────────────
  server.tool(
    "run_full_validation",
    "Run the complete validation suite: datastream config check, Tags property structure check, live Edge Network test, and optional website HTML check. Returns a scored report (A–F) with pass/warn/fail per section plus recommended actions.",
    {
      datastreamId: z.string().min(1),
      propertyId: z.string().min(1),
      websiteUrl: z.string().url().optional(),
      expectedScriptUrl: z.string().optional(),
    },
    async (input) => {
      try {
        const result = await runFullValidation(input);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
