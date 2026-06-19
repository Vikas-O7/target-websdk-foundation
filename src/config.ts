import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve .env relative to THIS source file, not process.cwd().
// When an MCP host (Claude Desktop, Claude Code, etc.) spawns the server,
// cwd is the host's install path — dotenv would silently miss our .env.
// Walking up two directories from `build/config.js` lands at the project
// root where the user's .env lives.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = resolve(__dirname, "..", ".env");
dotenv.config({ path: ENV_PATH });

// ── Schema ──────────────────────────────────────────────────
//
// This MCP needs an Adobe OAuth Server-to-Server credential with:
//   • Experience Platform Launch API (Reactor) added
//   • Adobe Experience Platform API added
// And the credential's technical account assigned to the corresponding
// product profiles in Admin Console. See docs/adobe-developer-console-setup.md.
const ConfigSchema = z.object({
  ADOBE_CLIENT_ID: z.string().min(1, "ADOBE_CLIENT_ID is required"),
  ADOBE_CLIENT_SECRET: z.string().min(1, "ADOBE_CLIENT_SECRET is required"),
  ADOBE_ORG_ID: z
    .string()
    .includes("@AdobeOrg", { message: "ADOBE_ORG_ID must contain @AdobeOrg" }),
  ADOBE_SCOPES: z
    .string()
    .default(
      "openid,AdobeID,read_organizations,additional_info.projectedProductContext,additional_info.roles"
    ),
  /**
   * AEP sandbox name to operate against. Most orgs use "prod" for their
   * production sandbox; non-prod sandboxes have custom names.
   */
  ADOBE_SANDBOX_NAME: z.string().default("prod"),
});

export type Config = z.infer<typeof ConfigSchema>;

// ── Parse & export ──────────────────────────────────────────
let config: Config;
try {
  config = ConfigSchema.parse(process.env);
} catch (err) {
  if (err instanceof z.ZodError) {
    const missing = err.issues.map((i) => i.path.join(".")).join(", ");
    console.error(`[config] Missing or invalid env vars: ${missing}`);
    console.error("[config] Copy .env.example → .env and fill in values.");
    console.error("[config] See docs/adobe-developer-console-setup.md for the credential setup walkthrough.");
  }
  process.exit(1);
}

export { config };

// ── Derived constants ───────────────────────────────────────
export const IMS_TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";
