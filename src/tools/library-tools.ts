import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDevLibrary, getDevLibraryStatus } from "../api/library.js";

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

export function registerLibraryTools(server: McpServer) {
  // ── create_dev_library ──────────────────────────────────
  server.tool(
    "create_dev_library",
    "Composite tool — create a development library, attach ALL extensions + data elements + rules on the property, trigger a build, poll until complete, and return the dev embed code. This is typically the final setup step before testing on a website. Build typically takes 10-60 seconds.",
    {
      propertyId: z.string().min(1),
      devEnvironmentId: z
        .string()
        .min(1)
        .describe(
          "Environment ID for the development stage — typically from setup_property_infrastructure or get_property_status."
        ),
      libraryName: z
        .string()
        .optional()
        .describe(
          "Display name for the library. Defaults to 'Target WebSDK Setup - YYYY-MM-DD'."
        ),
      buildTimeoutSeconds: z
        .number()
        .int()
        .positive()
        .max(600)
        .default(120)
        .describe("Max seconds to wait for the build to complete. Default 120."),
    },
    async (input) => {
      try {
        const result = await createDevLibrary(input);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── get_dev_library_status ──────────────────────────────
  server.tool(
    "get_dev_library_status",
    "Get the current development library status: last build time, build status, and resource counts. Use this to check whether the dev library needs to be rebuilt after changes to extensions, data elements, or rules.",
    {
      propertyId: z.string().min(1),
    },
    async ({ propertyId }) => {
      try {
        const result = await getDevLibraryStatus(propertyId);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
