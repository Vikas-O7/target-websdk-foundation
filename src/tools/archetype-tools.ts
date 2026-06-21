import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyArchetype } from "../api/archetypes.js";

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

export function registerArchetypeTools(server: McpServer) {
  // ── apply_archetype ────────────────────────────────────────
  server.tool(
    "apply_archetype",
    "Apply an opinionated, vertical-specific set of data elements and rules on top of a Tags property created by setup_target_websdk. v1.1 only ships 'ecommerce_standard' which adds: Product SKU/Name/Category DEs, Cart Item Count DE, XDM payload DEs for productViews/addToCart/checkouts, and 3 rules (PDP product-view firing on /product/* paths, Add to Cart firing on a 'ecommerce:addToCart' custom event, Checkout Start firing on /checkout). Idempotent: skips DEs and rules already present by name. After applying, run create_dev_library to rebuild.",
    {
      propertyId: z
        .string()
        .min(1)
        .describe("Tags property ID — must have setup_target_websdk's standard catalog already in place."),
      archetype: z
        .enum(["ecommerce_standard"])
        .describe(
          "Which archetype to apply. v1.1 ships only 'ecommerce_standard'; b2b_lead_gen / media_publisher / saas_funnel are scheduled for v1.2."
        ),
      pdpProductSkuPath: z
        .string()
        .optional()
        .describe(
          "JS path to current product SKU on PDP. Default: digitalData.product[0].productInfo.sku. The PDP rule looks for product info at this path; falls back to [itemprop='sku'] DOM selector."
        ),
      pdpProductNamePath: z
        .string()
        .optional()
        .describe(
          "JS path to current product name on PDP. Default: digitalData.product[0].productInfo.productName."
        ),
      pdpProductCategoryPath: z
        .string()
        .optional()
        .describe(
          "JS path to current product category on PDP. Default: digitalData.product[0].category.primaryCategory."
        ),
      cartItemsPath: z
        .string()
        .optional()
        .describe(
          "JS path to current cart items array (returns count of items). Default: digitalData.cart.item."
        ),
    },
    async (input) => {
      try {
        const result = await applyArchetype(input);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
