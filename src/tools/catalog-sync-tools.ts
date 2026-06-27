import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { syncPropertyCatalog } from "../api/catalog-sync.js";

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

export function registerCatalogSyncTools(server: McpServer) {
  server.tool(
    "sync_property_catalog",
    "v1.3 — Upgrade an existing Tags property to the latest standard catalog without re-running the full setup wizard. Adds any standard DEs and rules missing on the property; touches nothing already present. Use this when a property was created under an older MCP version (v1.0 / v1.1) and you want it to have v1.3's full DE catalog (Page-Type, Send Event Data wrapper). Does NOT update existing DEs/rules in place — if the page-load rule was created with DOM Ready, you must delete it manually before this tool can recreate it with Library Loaded. After running, call create_dev_library to publish the new resources into a build.",
    {
      propertyId: z.string().min(1),
      pageNamePath: z
        .string()
        .default("digitalData.page.pageInfo.pageName")
        .describe("Used only for NEWLY-ADDED Page - Name DE. Existing DEs are not modified."),
      crmIdPath: z
        .string()
        .default("digitalData.user[0].profile[0].profileInfo.profileID")
        .describe("Used only for NEWLY-ADDED identity DEs. Existing DEs are not modified."),
      orderIdPath: z
        .string()
        .optional()
        .describe("Used only when adding the orderTracking DEs. Default: digitalData.transaction.transactionID."),
      orderTotalPath: z
        .string()
        .optional()
        .describe("Used only when adding the orderTracking DEs. Default: digitalData.transaction.total.basePrice."),
      dataElementSelection: z
        .object({
          pageContext: z.boolean().optional(),
          identity: z.boolean().optional(),
          targetProfile: z.boolean().optional(),
          xdm: z.boolean().optional(),
          environment: z.boolean().optional(),
          orderTracking: z.boolean().optional(),
          overrides: z.record(z.string(), z.boolean()).optional(),
        })
        .optional()
        .describe(
          "Catalog selection. Default for sync: all categories ON (we want to add everything missing). Override to limit scope, e.g. { orderTracking: false } to skip order DEs."
        ),
      includePageLoadRule: z.boolean().default(true),
      includeOrderRule: z.boolean().default(false),
    },
    async (input) => {
      try {
        const result = await syncPropertyCatalog(input);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
