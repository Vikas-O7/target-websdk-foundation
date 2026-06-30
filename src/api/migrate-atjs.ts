/**
 * at.js → Web SDK one-shot migrator (v1.4).
 *
 * Composes the v1.4 atjs-analyzer + migration-runbook + existing
 * setup_target_websdk orchestrator into a single tool call. The headline
 * feature for consultants: point it at a live at.js site, get back a
 * consultant-grade migration runbook AND (optionally) the Web SDK
 * foundation already created on the user's tenant.
 *
 * Safety model — dry-run by default:
 *   migrate_atjs_to_websdk({ url, propertyName, domains })
 *     → analyze + render runbook + show planned setup call. Zero writes.
 *
 *   migrate_atjs_to_websdk({ url, propertyName, domains, dryRun: false })
 *     → all of the above, PLUS actually creates the datastream + property +
 *        web sdk extension + data elements + page-load rule + dev library.
 *
 * Refuse-to-run guards:
 *   • If the analyzer can't determine a client code and the caller didn't
 *     override, we refuse — the Target service won't work without one.
 *   • If the analyzer surfaces blockers (e.g. at.js 1.x end-of-life), we
 *     refuse unless `forceBlockers: true`. Forces an explicit consultant
 *     acknowledgement that they understand what they're cutting over.
 */

import {
  analyzeAtjsImplementation,
  type AtjsAnalysisReport,
  type AnalyzeAtjsInput,
} from "./atjs-analysis.js";
import { generateMigrationRunbook } from "./migration-runbook.js";
import type { SetupInput, SetupResult } from "./orchestration.js";

// `setupTargetWebsdk` is lazy-imported inside the live-run branch only.
// Importing it eagerly would trigger config.ts's stdio-mode env validation
// (Adobe credentials check), which is unwanted noise for the dry-run code
// path — dry-run does no Adobe API work and shouldn't require credentials.

// ── Types ───────────────────────────────────────────────────
export interface MigrateAtjsInput {
  /** Live at.js page URL to analyze. */
  url: string;

  /** Tags property name to create. Becomes the datastream name when datastreamName isn't set. */
  propertyName: string;

  /** Domains for the new property. Must include the production host of the migrating site. */
  domains: string[];

  /** Override datastream name if you don't want it to match propertyName. */
  datastreamName?: string;

  /** Pass through to analyzer (mboxes from network capture). */
  knownMboxes?: string[];
  /** Pass through to analyzer (settings from browser console). */
  targetGlobalSettings?: Record<string, unknown>;
  /** Pass through to analyzer (HTTP timeout). */
  fetchTimeoutMs?: number;

  /**
   * Override the client code the analyzer extracts. Useful when the
   * analyzer can't see the bundle (auth-walled sites) but the consultant
   * knows the value.
   */
  targetClientCode?: string;

  /**
   * Default true — DO NOT actually create resources, just analyze and
   * return the runbook + the planned setup call. Flip to false to
   * actually run setup_target_websdk after the analysis.
   */
  dryRun?: boolean;

  /**
   * Default false. When the analyzer surfaces blockers (e.g. at.js 1.x
   * end-of-life), refuse to proceed (dry-run or not). Set true to
   * acknowledge and proceed anyway.
   */
  forceBlockers?: boolean;

  /** Default true. Passed through to setup_target_websdk when dryRun is false. */
  runValidation?: boolean;

  /** Default true. Include the full markdown runbook in the response. */
  includeRunbook?: boolean;
}

export interface MigrateAtjsResult {
  dry_run: boolean;
  status:
    | "analyzed_dry_run"
    | "setup_succeeded"
    | "setup_partial_failure"
    | "refused_missing_client_code"
    | "refused_blockers_present";

  analysis: AtjsAnalysisReport;
  runbook_markdown: string | null;
  planned_setup_call: Partial<SetupInput>;
  setup_result: SetupResult | null;

  refusal_reason: string | null;
  next_steps: string[];
  warnings: string[];
}

// ── Public migrator ─────────────────────────────────────────
export async function migrateAtjsToWebsdk(
  input: MigrateAtjsInput
): Promise<MigrateAtjsResult> {
  const dryRun = input.dryRun !== false;
  const warnings: string[] = [];

  // Step 1 — run the analyzer
  const analyzerInput: AnalyzeAtjsInput = {
    url: input.url,
    knownMboxes: input.knownMboxes,
    targetGlobalSettings: input.targetGlobalSettings,
    fetchTimeoutMs: input.fetchTimeoutMs,
  };
  const analysis = await analyzeAtjsImplementation(analyzerInput);

  // Step 2 — derive the planned setup_target_websdk parameters
  const clientCode =
    input.targetClientCode ?? analysis.recommended_setup.targetClientCode ?? null;

  const plannedSetup: Partial<SetupInput> = {
    datastreamName: input.datastreamName ?? input.propertyName,
    propertyName: input.propertyName,
    domains: input.domains,
    runValidation: input.runValidation ?? true,
  };
  if (clientCode) plannedSetup.targetClientCode = clientCode;
  if (analysis.recommended_setup.flickerSelectors) {
    plannedSetup.flickerSelectors = analysis.recommended_setup.flickerSelectors;
  } else if (analysis.recommended_setup.flickerStyle) {
    plannedSetup.flickerStyle = analysis.recommended_setup.flickerStyle;
  }
  if (analysis.recommended_setup.consentMode !== "in") {
    plannedSetup.consentMode = analysis.recommended_setup.consentMode;
  }
  if (analysis.recommended_setup.includeA4t) {
    plannedSetup.includeA4t = true;
    // Note: includeA4t requires reportSuites + trackingServer. The analyzer
    // can extract trackingServer in some cases, but reportSuites NEVER —
    // call this out clearly in next_steps.
  }

  // Step 3 — refuse-to-run guards
  if (!clientCode) {
    return {
      dry_run: dryRun,
      status: "refused_missing_client_code",
      analysis,
      runbook_markdown: renderRunbookIfRequested(analysis, input),
      planned_setup_call: plannedSetup,
      setup_result: null,
      refusal_reason:
        "No targetClientCode could be inferred from the at.js site and none was provided. Without a client code, the new Web SDK datastream's Target service can't be wired. Re-run with targetClientCode set explicitly.",
      next_steps: [
        "Find the client code in the Adobe Target UI: Settings → Visitor Profile, or in the existing Tags property's at.js extension config.",
        "Re-run migrate_atjs_to_websdk with targetClientCode set explicitly.",
      ],
      warnings: [...analysis.warnings, ...warnings],
    };
  }

  if (analysis.migration_plan.blockers.length > 0 && !input.forceBlockers) {
    return {
      dry_run: dryRun,
      status: "refused_blockers_present",
      analysis,
      runbook_markdown: renderRunbookIfRequested(analysis, input),
      planned_setup_call: plannedSetup,
      setup_result: null,
      refusal_reason: `${analysis.migration_plan.blockers.length} migration blocker(s) present. Review them in the runbook §1 and acknowledge by re-running with forceBlockers:true if you want to proceed anyway.`,
      next_steps: [
        "Read the blocker(s) in analysis.migration_plan.blockers and the §1 executive summary of the runbook.",
        "If the blockers are accepted/understood, re-run with forceBlockers:true to proceed.",
        "If the blockers require remediation first (e.g. upgrade at.js 1.x → 2.x before cutover), do that and re-run analyze_atjs_implementation to confirm.",
      ],
      warnings: [...analysis.warnings, ...warnings],
    };
  }

  // Step 4 — dry-run vs. live
  if (dryRun) {
    return {
      dry_run: true,
      status: "analyzed_dry_run",
      analysis,
      runbook_markdown: renderRunbookIfRequested(analysis, input),
      planned_setup_call: plannedSetup,
      setup_result: null,
      refusal_reason: null,
      next_steps: [
        "Review the runbook (runbook_markdown).",
        "Review the planned_setup_call for the exact parameters that will be sent to setup_target_websdk.",
        "When ready to actually create the Web SDK foundation, re-run with dryRun:false.",
        ...(analysis.recommended_setup.includeA4t
          ? [
              "A4T detected — after dryRun:false succeeds, you'll need to call add_analytics_to_datastream separately with reportSuites + trackingServer. Neither can be auto-inferred.",
            ]
          : []),
        ...(analysis.atjs.mboxes.total_unique === 0
          ? [
              "No mboxes catalogued from the static analysis. Before live cutover, capture the runtime mbox list from a browser network trace (search 'tt.omtrdc.net/m2') and re-run the migrator with knownMboxes to refresh the runbook.",
            ]
          : []),
      ],
      warnings: [...analysis.warnings, ...warnings],
    };
  }

  // Step 5 — actually run setup_target_websdk (lazy-imported)
  const { setupTargetWebsdk } = await import("./orchestration.js");
  const setup = await setupTargetWebsdk(plannedSetup as SetupInput);

  return {
    dry_run: false,
    status:
      setup.status === "success" ? "setup_succeeded" : "setup_partial_failure",
    analysis,
    runbook_markdown: renderRunbookIfRequested(analysis, input),
    planned_setup_call: plannedSetup,
    setup_result: setup,
    refusal_reason: null,
    next_steps: [
      ...setup.next_steps,
      ...(analysis.recommended_setup.includeA4t
        ? [
            "A4T detected — call add_analytics_to_datastream with the datastream_id from setup_result, reportSuites: ['<your-report-suite-id>'], and trackingServer to finish the A4T wiring.",
          ]
        : []),
      ...(analysis.atjs.mboxes.total_unique === 0
        ? [
            "No mboxes catalogued — before flipping the production embed, capture the runtime mbox list from a browser network trace and add the relevant decisionScopes to the page-load rule's Send Event action.",
          ]
        : []),
      "Follow the 5-phase migration plan in the runbook for the actual cutover.",
    ],
    warnings: [...analysis.warnings, ...warnings],
  };
}

function renderRunbookIfRequested(
  analysis: AtjsAnalysisReport,
  input: MigrateAtjsInput
): string | null {
  if (input.includeRunbook === false) return null;
  return generateMigrationRunbook(analysis, {
    projectName: input.propertyName,
  });
}
