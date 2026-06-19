import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listProperties,
  createTagsProperty,
  setupPropertyInfrastructure,
  installWebSdkExtension,
  resolveExtensionIds,
  createStandardDataElements,
  createStandardRules,
  getPropertyStatus,
  getEmbedCode,
} from "../api/setup.js";

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

export function registerSetupTools(server: McpServer) {
  // ── list_properties ─────────────────────────────────────
  server.tool(
    "list_properties",
    "List Tags (Launch) properties in the org. Use before creating a property to check if one already exists with that name. Returns id, name, platform, domains, enabled flag.",
    {
      nameFilter: z
        .string()
        .optional()
        .describe("Case-insensitive substring match on property name."),
    },
    async ({ nameFilter }) => {
      try {
        const result = await listProperties(nameFilter);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── create_tags_property ────────────────────────────────
  server.tool(
    "create_tags_property",
    "Create a new Tags (Launch) property. This is the container for all WebSDK extensions, data elements, rules, and libraries. If a property with the same name already exists and returnIfExists is true (default), returns the existing one instead of erroring.",
    {
      name: z
        .string()
        .min(1)
        .describe("Display name, e.g. 'Luma - Target WebSDK'."),
      domains: z
        .array(z.string().min(1))
        .min(1)
        .describe("Apex / canonical domains, e.g. ['luma.com', 'www.luma.com']."),
      returnIfExists: z.boolean().default(true),
    },
    async ({ name, domains, returnIfExists }) => {
      try {
        const result = await createTagsProperty({
          name,
          domains,
          returnIfExists,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── setup_property_infrastructure ───────────────────────
  server.tool(
    "setup_property_infrastructure",
    "Create the Akamai (Adobe-managed) host and all three environments (Development, Staging, Production) for a Tags property. Returns embed codes for all three environments. Call immediately after create_tags_property.",
    {
      propertyId: z.string().min(1),
    },
    async ({ propertyId }) => {
      try {
        const result = await setupPropertyInfrastructure(propertyId);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── install_websdk_extension ────────────────────────────
  server.tool(
    "install_websdk_extension",
    "Install and configure the AEP Web SDK (alloy) extension on a Tags property. Links the property to a datastream. This is the core extension required for Target Web SDK. If alloy is already installed, the existing extension is returned without changes.",
    {
      propertyId: z.string().min(1),
      datastreamId: z.string().min(1),
      orgId: z
        .string()
        .optional()
        .describe(
          "Adobe Org ID (XXXXX@AdobeOrg). Defaults to ADOBE_ORG_ID env var."
        ),
      flickerStyle: z
        .string()
        .default("body { opacity: 0 !important }")
        .describe(
          "CSS rule used to hide the page while Target activities load. Scope to specific containers for better perceived performance."
        ),
      idMigrationEnabled: z
        .boolean()
        .default(false)
        .describe("Set true only when migrating from at.js."),
      targetMigrationEnabled: z
        .boolean()
        .default(false)
        .describe(
          "Set true only when running at.js and Web SDK in parallel during a migration."
        ),
      defaultConsent: z.enum(["in", "pending"]).default("in"),
      thirdPartyCookies: z.boolean().default(false),
    },
    async (input) => {
      try {
        const result = await installWebSdkExtension(input);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── create_standard_data_elements ───────────────────────
  server.tool(
    "create_standard_data_elements",
    "Create the standard data elements required for a Target Web SDK implementation: page context, XDM object, identity map, Target profile/mbox attributes, and optional order data elements. Skips DEs that already exist by name. Pass alloyExtensionId and coreExtensionId from install_websdk_extension (or list extensions on the property to find them).",
    {
      propertyId: z.string().min(1),
      alloyExtensionId: z.string().min(1),
      coreExtensionId: z.string().min(1),
      pageNameDataLayerPath: z
        .string()
        .default("digitalData.page.pageInfo.pageName"),
      crmIdDataLayerPath: z
        .string()
        .default("digitalData.user[0].profile[0].profileInfo.profileID"),
      orderIdPath: z
        .string()
        .default("digitalData.transaction.transactionID"),
      orderTotalPath: z
        .string()
        .default("digitalData.transaction.total.basePrice"),
      includeOrderDes: z.boolean().default(false),
    },
    async (input) => {
      try {
        const result = await createStandardDataElements(input);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── create_standard_rules ───────────────────────────────
  server.tool(
    "create_standard_rules",
    "Create the standard rules for a Target Web SDK implementation. At minimum: page load Send Event rule with renderDecisions. Optionally adds order-confirmation purchase rule and SPA view change rule. References data elements by name (%DE Name% syntax) — those DEs must already exist on the property.",
    {
      propertyId: z.string().min(1),
      alloyExtensionId: z.string().min(1),
      coreExtensionId: z.string().min(1),
      renderDecisions: z.boolean().default(true),
      includeOrderRule: z.boolean().default(false),
      includeSpaRule: z.boolean().default(false),
      includeClickRule: z.boolean().default(false),
      orderPagePath: z.string().default("/order-confirmation"),
    },
    async (input) => {
      try {
        const result = await createStandardRules(input);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── get_property_status ─────────────────────────────────
  server.tool(
    "get_property_status",
    "Get a complete status overview of a Tags property: installed extensions with versions, data element count, rule count, and embed codes for every environment. Use to audit what's been set up so far on a property.",
    {
      propertyId: z.string().min(1),
    },
    async ({ propertyId }) => {
      try {
        const result = await getPropertyStatus(propertyId);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── get_embed_code ──────────────────────────────────────
  server.tool(
    "get_embed_code",
    "Get the <script> embed tag for a specific Tags environment. Most commonly called with the development environment ID after create_dev_library completes — that returns the embed code to paste into a website for testing.",
    {
      environmentId: z.string().min(1),
    },
    async ({ environmentId }) => {
      try {
        const result = await getEmbedCode(environmentId);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // resolveExtensionIds is intentionally NOT exposed as a tool — it's a
  // helper used by the orchestration tool. Callers who need it can list
  // extensions via get_property_status and pick the IDs from there.
  void resolveExtensionIds; // tree-shake guard
}
