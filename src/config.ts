import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getRequestConfig, type RequestConfig } from "./request-context.js";

// ── .env loading (stdio mode only) ───────────────────────────
//
// In HTTP mode the .env file is optional / absent — credentials come from
// per-request headers. We still attempt to load .env so stdio mode works
// without changes. If .env is missing or values are placeholders, the
// schema parse below stays lenient when MCP_TRANSPORT=http; strict
// otherwise.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = resolve(__dirname, "..", ".env");
dotenv.config({ path: ENV_PATH });

const TRANSPORT = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
export const IS_HTTP_MODE = TRANSPORT === "http";

// ── Schema ──────────────────────────────────────────────────
const StrictSchema = z.object({
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
  ADOBE_SANDBOX_NAME: z.string().default("prod"),
});

export type Config = z.infer<typeof StrictSchema>;

// ── Static config: built from env at boot (stdio mode default) ─
//
// In HTTP mode this stays unset — `getConfig()` will throw if it's
// accessed without a request context, which is the correct failure
// mode (HTTP handler must always run inside runWithRequestConfig).
let staticConfig: Config | null = null;

try {
  staticConfig = StrictSchema.parse(process.env);
} catch (err) {
  if (IS_HTTP_MODE) {
    // HTTP mode: no env-based credentials needed; each request carries
    // its own. Leave staticConfig null.
    staticConfig = null;
  } else {
    if (err instanceof z.ZodError) {
      const missing = err.issues.map((i) => i.path.join(".")).join(", ");
      console.error(`[config] Missing or invalid env vars: ${missing}`);
      console.error("[config] Copy .env.example → .env and fill in values.");
      console.error(
        "[config] See docs/adobe-developer-console-setup.md for the credential setup walkthrough."
      );
    }
    process.exit(1);
  }
}

// ── Public: get the active config for this call site ─────────
//
// Reads order:
//   1. AsyncLocalStorage context (HTTP mode, per-request)
//   2. Static env-parsed config (stdio mode)
//   3. Throws if neither — programming error
//
// Callers can either access `config.X` (Proxy-backed, ergonomic) or
// call `getConfig()` explicitly (clearer at API client level).
export function getConfig(): Config {
  const requestCfg: RequestConfig | undefined = getRequestConfig();
  if (requestCfg) return requestCfg as Config;
  if (staticConfig) return staticConfig;
  throw new Error(
    "[config] No request context and no static credentials. " +
      "In HTTP mode, every tool call must be wrapped in runWithRequestConfig() " +
      "with credentials extracted from request headers."
  );
}

// ── Proxy-backed config (backward compatibility) ─────────────
//
// Existing code does `config.ADOBE_CLIENT_ID`. The Proxy routes each
// property access through getConfig() — pulling from the right source
// for the current async context with no API change.
export const config: Config = new Proxy({} as Config, {
  get(_target, prop) {
    const c = getConfig();
    return c[prop as keyof Config];
  },
}) as Config;

// ── Derived constants ───────────────────────────────────────
export const IMS_TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";
