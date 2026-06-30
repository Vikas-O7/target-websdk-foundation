import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeAtjsImplementation } from "../api/atjs-analysis.js";
import { generateMigrationRunbook } from "../api/migration-runbook.js";
import { migrateAtjsToWebsdk } from "../api/migrate-atjs.js";
import { generateAtjsCompatShim } from "../api/compat-shim.js";
import { diffAtjsVsWebsdk } from "../api/migration-diff.js";

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

export function registerAtjsAnalysisTools(server: McpServer) {
  // ── analyze_atjs_implementation ────────────────────────────
  server.tool(
    "analyze_atjs_implementation",
    "v1.4 — Static-fetch analysis of an existing Adobe Target at.js implementation, scoped to producing the inputs setup_target_websdk needs to create the Web SDK equivalent. Complements discover_site (which gives a 1-line yes/no for at.js) by returning the full picture: at.js version + CDN host + client code, parsed targetGlobalSettings via a permissive object-literal parser, mbox catalog (declarative DOM + inline call sites + user-provided), prehiding strategy (whole-body vs scoped), A4T detection, and a setting-by-setting at.js → Web SDK / Datastream mapping table with confidence levels. Returns recommended_setup pre-filled for setup_target_websdk plus a migration_plan listing auto-mappable items, manual-review items, and blockers. Static fetch only — does NOT execute JavaScript. SPAs / runtime-injected settings: capture from browser console and pass via knownMboxes / targetGlobalSettings params for a complete report. NOT for activity migration (HTML offer transformation, audience rules) — that's Adobe's official Target MCP's scope.",
    {
      url: z
        .string()
        .url()
        .describe(
          "Full URL of an at.js page to analyze. For multi-page sites, pick a page that exercises Target — PDPs and the homepage usually have the most mbox markers in the served HTML."
        ),
      knownMboxes: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Optional list of mbox names captured from a browser network trace (search for 'tt.omtrdc.net/m2' requests). Merged with mboxes the static analyzer extracts from the HTML; deduplication is automatic. Strongly recommended for SPAs and any site that creates mboxes via JS at runtime."
        ),
      targetGlobalSettings: z
        .record(z.unknown())
        .optional()
        .describe(
          "Optional pre-captured `window.targetGlobalSettings` dictionary. When provided, values here override / augment whatever the parser extracts from the inline HTML. Use this when the settings dict is set by a build pipeline / runtime config fetch and isn't in the served HTML."
        ),
      fetchTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe(
          "HTTP fetch timeout in milliseconds. Default 10000. Bump for slow-loading sites."
        ),
    },
    async ({ url, knownMboxes, targetGlobalSettings, fetchTimeoutMs }) => {
      try {
        const result = await analyzeAtjsImplementation({
          url,
          knownMboxes,
          targetGlobalSettings,
          fetchTimeoutMs,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── generate_atjs_migration_runbook ────────────────────────
  server.tool(
    "generate_atjs_migration_runbook",
    "v1.4 — Generate a consultant-grade Markdown migration runbook for an existing Adobe Target at.js site. Composes analyze_atjs_implementation + a Markdown renderer in one call. Output is a single hand-off deliverable (~3-5 pages) covering: executive summary with effort estimate and analysis confidence, current-state inventory (library + settings + mboxes + prehide + A4T), at.js → Web SDK mapping table with confidence labels, a concrete copy-pasteable setup_target_websdk call with parameters interpolated from the analysis, a 5-phase step-by-step plan (prepare / create / staging / cutover / cleanup), per-site decisions the consultant must resolve, a post-cutover verification checklist, and the raw analysis JSON in an appendix. Static fetch only — augment SPA / runtime-injected settings via knownMboxes / targetGlobalSettings as with analyze_atjs_implementation. Output is plain markdown text; pipe to a file or paste into a doc.",
    {
      url: z
        .string()
        .url()
        .describe(
          "Full URL of an at.js page to analyze and render a runbook for."
        ),
      knownMboxes: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Optional list of mbox names from a browser network trace. Merged with statically-extracted mboxes; dedup is automatic."
        ),
      targetGlobalSettings: z
        .record(z.unknown())
        .optional()
        .describe(
          "Optional pre-captured `window.targetGlobalSettings`. Values here override what the parser extracts from inline HTML."
        ),
      projectName: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Project/property name to interpolate into the setup_target_websdk code sample. Default: derived from URL hostname + today's date (e.g. `example-com-websdk-2026-06-30`)."
        ),
      includeAppendix: z
        .boolean()
        .optional()
        .describe(
          "Whether to include the raw analysis JSON appendix at the end of the runbook. Default true."
        ),
      fetchTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe("HTTP fetch timeout. Default 10000ms."),
    },
    async ({
      url,
      knownMboxes,
      targetGlobalSettings,
      projectName,
      includeAppendix,
      fetchTimeoutMs,
    }) => {
      try {
        const report = await analyzeAtjsImplementation({
          url,
          knownMboxes,
          targetGlobalSettings,
          fetchTimeoutMs,
        });
        const md = generateMigrationRunbook(report, {
          projectName,
          includeAppendix,
        });
        return ok(md);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── migrate_atjs_to_websdk ─────────────────────────────────
  server.tool(
    "migrate_atjs_to_websdk",
    "v1.4 — One-shot at.js → Web SDK migrator. Composes analyze_atjs_implementation + generate_atjs_migration_runbook + setup_target_websdk into a single call. Defaults to dryRun:true: returns the analysis + runbook + the EXACT setup_target_websdk parameters that would be sent — but performs ZERO tenant writes until you re-run with dryRun:false. Refuse-to-run guards: refuses if the analyzer can't determine a Target client code (no client code = broken datastream) and refuses if migration blockers are present (e.g. at.js 1.x EOL) unless forceBlockers:true is set. Headline workflow: (1) dry-run against the at.js URL → review the runbook + planned setup call, (2) re-run with dryRun:false to actually create the Web SDK foundation. Returns analysis JSON, runbook markdown, planned_setup_call params, and (when not dryRun) the full setup_result with datastream/property/environment IDs.",
    {
      url: z
        .string()
        .url()
        .describe("Full URL of the at.js page to migrate from."),
      propertyName: z
        .string()
        .min(1)
        .describe(
          "Name for the new Tags property. Becomes the datastream name too unless datastreamName is overridden. Recommended convention: `<site>-websdk-<date>` e.g. `paloaltonetworks-websdk-2026-06-30`."
        ),
      domains: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Domains for the new Tags property. Must include the production hostname of the site being migrated."
        ),
      datastreamName: z
        .string()
        .min(1)
        .optional()
        .describe("Override the datastream name. Defaults to propertyName."),
      knownMboxes: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Mbox names from a browser network trace. Strongly recommended — at.js sites typically register mboxes at runtime so static analysis misses them."
        ),
      targetGlobalSettings: z
        .record(z.unknown())
        .optional()
        .describe(
          "Pre-captured `window.targetGlobalSettings`. Overrides whatever the analyzer extracts from inline HTML or Tags bundle."
        ),
      targetClientCode: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Override the client code the analyzer extracts. Required when the analyzer can't see the bundle (auth-walled sites, runtime-only config)."
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Default true. When true, returns analysis + runbook + planned setup call with ZERO tenant writes. Set false to actually create the datastream + property + extensions + DEs + rules + dev library on the user's Adobe tenant."
        ),
      forceBlockers: z
        .boolean()
        .optional()
        .describe(
          "Default false. The migrator refuses to proceed (dry-run or not) when the analyzer surfaces blockers (e.g. at.js 1.x EOL). Set true to acknowledge and proceed anyway."
        ),
      runValidation: z
        .boolean()
        .optional()
        .describe(
          "Default true. Passed through to setup_target_websdk when dryRun is false."
        ),
      includeRunbook: z
        .boolean()
        .optional()
        .describe(
          "Default true. Include the full markdown runbook in the response. Set false for compact JSON-only responses."
        ),
      fetchTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe("HTTP fetch timeout for the analyzer. Default 10000ms."),
    },
    async (args) => {
      try {
        const result = await migrateAtjsToWebsdk(args);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── generate_atjs_compat_shim ──────────────────────────────
  server.tool(
    "generate_atjs_compat_shim",
    "v1.4 — Generate a runtime JS compatibility shim that lets a site keep its existing at.js call sites working while the underlying delivery flips to Adobe Web SDK. The differentiator for large migrations: instead of refactoring hundreds of `adobe.target.getOffer(...)` / `applyOffer(...)` / `trackEvent(...)` / `triggerView(...)` call sites in one PR, deploy the shim alongside Web SDK and retire it incrementally. Returns: (1) the standalone shim JS (~10KB, no deps, IIFE, ES2017+) for the consultant to save into their codebase, (2) deployment + verification + retirement instructions, (3) metadata (clientCode, mbox count, generation timestamp). The shim translates Web SDK propositions ↔ at.js offers (HTML/JSON/redirect/default schemas), warns when called with a mbox not in the analyzer's catalog (catches typos), and exposes a `?target_shim_debug=1` URL flag for verbose console logging. Pairs with analyze_atjs_implementation + migrate_atjs_to_websdk — analyze first, then generate the shim from the resulting report.",
    {
      url: z
        .string()
        .url()
        .describe(
          "Full URL of the at.js page to analyze and build a shim for."
        ),
      knownMboxes: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Mbox names from a browser network trace. Augments the analyzer's catalog — the shim warns at runtime when a `getOffer(name)` is called with a mbox not in this catalog, so a complete catalog catches typos and stale call sites early."
        ),
      targetGlobalSettings: z
        .record(z.unknown())
        .optional()
        .describe(
          "Pre-captured `window.targetGlobalSettings` from browser console."
        ),
      clientCode: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Override the clientCode the analyzer extracts. Used as a log prefix in the shim (no functional impact on Edge delivery — clientCode is org-level in Web SDK)."
        ),
      debug: z
        .boolean()
        .optional()
        .describe(
          "Default false. When true, the shim emits console.log on every call (no need for the `?target_shim_debug=1` URL flag). Useful when generating a shim for staging-only deployment."
        ),
      alloyInstance: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Default \"alloy\". The Web SDK global name. Override only if your Web SDK extension was configured with a non-default instance name (rare)."
        ),
      fetchTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe("HTTP fetch timeout for the analyzer step. Default 10000ms."),
    },
    async ({
      url,
      knownMboxes,
      targetGlobalSettings,
      clientCode,
      debug,
      alloyInstance,
      fetchTimeoutMs,
    }) => {
      try {
        const report = await analyzeAtjsImplementation({
          url,
          knownMboxes,
          targetGlobalSettings,
          fetchTimeoutMs,
        });
        const shim = generateAtjsCompatShim(report, {
          clientCode,
          debug,
          alloyInstance,
        });
        return ok(JSON.stringify(shim, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── diff_atjs_vs_websdk_implementation ─────────────────────
  server.tool(
    "diff_atjs_vs_websdk_implementation",
    "v1.4 — Cross-implementation verification. Takes an at.js page URL + a Tags property ID on your tenant, and reports the gaps between what at.js was doing and what the new Web SDK property covers. Closes out the migration toolkit (analyze → migrate → shim → DIFF). Runs ~9 checks: Web SDK extension installed + wired to a datastream, Target service enabled on the datastream, client code parity between sides, at.js host covered by Web SDK property's domain list, page-load rule with Send Event action present, A4T datastream Analytics service enabled when at.js had A4T markers, mbox-strategy reminder, standard v1.3 DE catalog completeness. Each check has severity (critical/error/warn/info), status (pass/fail/warn/info), detail, and a recommendation. Returns a grade (A-F) + score so you can gate the production cutover on validation results. Pure read — no tenant writes.",
    {
      url: z
        .string()
        .url()
        .describe("Full URL of the at.js page being migrated from."),
      propertyId: z
        .string()
        .min(1)
        .describe(
          "Tags property ID of the new Web SDK property (e.g. `PRabcd1234...`). Pulled from the migrate_atjs_to_websdk response."
        ),
      datastreamId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Override the datastream ID. By default, extracted from the alloy extension's settings on the property. Override only if the extension settings can't be parsed."
        ),
      knownMboxes: z
        .array(z.string().min(1))
        .optional()
        .describe("Mbox names from network capture — same semantics as analyze_atjs_implementation."),
      targetGlobalSettings: z
        .record(z.unknown())
        .optional()
        .describe("Pre-captured targetGlobalSettings — same semantics as analyze_atjs_implementation."),
      fetchTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe("HTTP fetch timeout for the at.js analyzer step. Default 10000ms."),
    },
    async (args) => {
      try {
        const result = await diffAtjsVsWebsdk(args);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
