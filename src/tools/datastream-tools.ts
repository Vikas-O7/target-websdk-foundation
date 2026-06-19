import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listDatastreams,
  createDatastream,
  addTargetToDatastream,
  addAnalyticsToDatastream,
} from "../api/datastreams.js";

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

export function registerDatastreamTools(server: McpServer) {
  // ── list_datastreams ────────────────────────────────────
  server.tool(
    "list_datastreams",
    "List all AEP datastreams in the configured sandbox. Use this to find an existing datastream before creating a new one. Returns id, name, description, and the list of configured services (e.g. Target, Analytics) for each datastream.",
    {
      nameFilter: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring match on the datastream name. Optional."
        ),
    },
    async ({ nameFilter }) => {
      try {
        const result = await listDatastreams(nameFilter);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── create_datastream ───────────────────────────────────
  server.tool(
    "create_datastream",
    "Create a new AEP datastream. This is the edge configuration that links a Tags property to Adobe services. Call add_target_to_datastream after this to wire Target into the datastream.",
    {
      name: z.string().min(1).describe("Datastream display name."),
      description: z.string().optional(),
      targetMigrationEnabled: z
        .boolean()
        .default(false)
        .describe(
          "Set true ONLY when running at.js in parallel with Web SDK during a migration. Default false."
        ),
    },
    async ({ name, description, targetMigrationEnabled }) => {
      try {
        const result = await createDatastream({
          name,
          description,
          targetMigrationEnabled,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── add_target_to_datastream ────────────────────────────
  server.tool(
    "add_target_to_datastream",
    "Add or update the Adobe Target service on a datastream. Required before the Web SDK extension can deliver Target activities. If the service already exists on this datastream it will be updated (read-modify-write).",
    {
      datastreamId: z.string().min(1),
      clientCode: z
        .string()
        .min(1)
        .describe(
          "Adobe Target client code (e.g. 'agsinternal'). Same value used for ADOBE_TARGET_CLIENT_CODE in the Delivery API."
        ),
      propertyToken: z
        .string()
        .optional()
        .describe(
          "at_property token for workspace isolation. Look this up in Target UI → Administration → Properties. Optional."
        ),
      environment: z
        .enum(["production", "staging", "development"])
        .default("production"),
      timeoutMs: z.number().int().positive().default(5000),
      a4tEnabled: z
        .boolean()
        .default(false)
        .describe(
          "Enable Analytics for Target. Requires the Analytics service to ALSO be added to this datastream — call add_analytics_to_datastream first."
        ),
    },
    async ({
      datastreamId,
      clientCode,
      propertyToken,
      environment,
      timeoutMs,
      a4tEnabled,
    }) => {
      try {
        const result = await addTargetToDatastream(datastreamId, {
          clientCode,
          propertyToken: propertyToken ?? null,
          environment,
          timeout: timeoutMs,
          a4tEnabled,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── add_analytics_to_datastream ─────────────────────────
  server.tool(
    "add_analytics_to_datastream",
    "Add or update the Adobe Analytics service on a datastream. Required to enable A4T (Analytics for Target). Call this BEFORE setting a4tEnabled=true on the Target service.",
    {
      datastreamId: z.string().min(1),
      reportSuites: z
        .array(z.string().min(1))
        .min(1)
        .describe("One or more Analytics report suite IDs."),
      trackingServer: z
        .string()
        .min(1)
        .describe("Analytics tracking server, e.g. 'luma.sc.omtrdc.net'."),
      sslTrackingServer: z
        .string()
        .optional()
        .describe(
          "SSL tracking server. Defaults to the same value as trackingServer if omitted."
        ),
    },
    async ({ datastreamId, reportSuites, trackingServer, sslTrackingServer }) => {
      try {
        const result = await addAnalyticsToDatastream(datastreamId, {
          reportSuites,
          trackingServer,
          sslTrackingServer,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
