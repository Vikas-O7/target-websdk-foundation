/**
 * at.js → Web SDK migration runbook renderer (v1.4).
 *
 * Pure function. Takes an `AtjsAnalysisReport` (from `analyzeAtjsImplementation`)
 * and renders a consultant-grade migration runbook in Markdown. Zero side
 * effects, zero network calls — just text formatting.
 *
 * Renders 8 sections:
 *   1. Executive summary
 *   2. Current state inventory
 *   3. Migration mappings (settings, mboxes, prehide, A4T)
 *   4. Recommended setup_target_websdk call (concrete, copy-pasteable)
 *   5. Step-by-step migration plan
 *   6. Decisions required
 *   7. Verification checklist
 *   8. Appendix (raw analysis JSON)
 *
 * Tone: direct, action-oriented. Output is meant to be a single hand-off
 * deliverable a consultant can email to a client or paste into a project
 * ticket. No marketing language, no Adobe-buzzword filler.
 */

import type { AtjsAnalysisReport, AtjsToWebSdkMapping } from "./atjs-analysis.js";

export interface RunbookOptions {
  /** Project / property name to use in code samples. Default: derived from URL host. */
  projectName?: string;
  /** Toggle the raw-analysis appendix. Default: true. */
  includeAppendix?: boolean;
  /** Override the generation timestamp (testing). Default: now. */
  generatedAtIso?: string;
}

const MCP_VERSION_TAG = "v1.4";

// ── Public renderer ─────────────────────────────────────────
export function generateMigrationRunbook(
  report: AtjsAnalysisReport,
  options: RunbookOptions = {}
): string {
  const lines: string[] = [];
  const project =
    options.projectName ?? deriveProjectName(report.url);
  const generatedAt =
    options.generatedAtIso ?? new Date().toISOString().slice(0, 10);

  // Header
  lines.push(`# Adobe Target at.js → Web SDK Migration Runbook`);
  lines.push("");
  lines.push(`**Site:** ${report.url}`);
  lines.push(`**Generated:** ${generatedAt}`);
  lines.push(`**Tool:** target-websdk-foundation ${MCP_VERSION_TAG}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Sections
  renderExecutiveSummary(lines, report);
  renderInventory(lines, report);
  renderMappings(lines, report);
  renderRecommendedCall(lines, report, project);
  renderStepPlan(lines, report);
  renderDecisions(lines, report);
  renderVerificationChecklist(lines, report);
  if (options.includeAppendix !== false) {
    renderAppendix(lines, report);
  }

  return lines.join("\n");
}

// ── Sections ────────────────────────────────────────────────
function renderExecutiveSummary(
  lines: string[],
  r: AtjsAnalysisReport
): void {
  lines.push("## 1. Executive summary");
  lines.push("");

  // Current state
  const currentParts: string[] = [];
  if (r.atjs.version !== "unknown") currentParts.push(`at.js ${r.atjs.version}`);
  if (r.atjs.client_code) currentParts.push(`client \`${r.atjs.client_code}\``);
  if (r.atjs.mboxes.total_unique > 0)
    currentParts.push(
      `${r.atjs.mboxes.total_unique} mbox${r.atjs.mboxes.total_unique === 1 ? "" : "es"} catalogued`
    );
  if (r.atjs.prehiding.detected)
    currentParts.push(`${r.atjs.prehiding.style} prehiding`);
  if (r.atjs.a4t.detected) currentParts.push("A4T active");
  lines.push(
    `**Current state:** ${currentParts.length > 0 ? currentParts.join(" · ") : "no at.js markers detected"}`
  );
  lines.push("");

  // Target state
  lines.push(
    `**Target state:** Adobe Web SDK (alloy) wired to an AEP Datastream` +
      `${r.atjs.a4t.detected ? " with A4T enabled" : ""}` +
      `, served via Adobe Tags, configured through the \`target-websdk-foundation\` MCP.`
  );
  lines.push("");

  // Blockers
  if (r.migration_plan.blockers.length > 0) {
    lines.push(`**Blockers (${r.migration_plan.blockers.length}):**`);
    for (const b of r.migration_plan.blockers) lines.push(`- ${b}`);
    lines.push("");
  } else {
    lines.push(
      `**Blockers:** none. Migration can proceed directly to setup.`
    );
    lines.push("");
  }

  // Effort
  lines.push(
    `**Estimated effort:** ${estimateEffort(r)} (varies with site complexity — re-estimate after the verification phase).`
  );
  lines.push("");

  // Confidence in this analysis
  const confidence = analysisConfidence(r);
  lines.push(`**Analysis confidence:** ${confidence}.`);
  lines.push("");
}

function renderInventory(lines: string[], r: AtjsAnalysisReport): void {
  lines.push("## 2. Current state inventory");
  lines.push("");

  // at.js library
  lines.push("### at.js library");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Version | ${escapeCell(r.atjs.version)} |`);
  lines.push(`| Version evidence | ${escapeCell(r.atjs.version_evidence)} |`);
  lines.push(`| CDN host | ${escapeCell(r.atjs.cdn_host ?? "—")} |`);
  lines.push(
    `| Library URL | ${escapeCell(r.atjs.library_url ?? "—")} |`
  );
  lines.push(`| Client code | ${escapeCell(r.atjs.client_code ?? "—")} |`);
  lines.push("");

  // Settings
  lines.push("### targetGlobalSettings");
  lines.push("");
  if (!r.atjs.target_global_settings.detected) {
    lines.push(
      "_Not detected in served HTML. Many sites set this via build pipeline or runtime config fetch — capture from browser console (`window.targetGlobalSettings`) and pass to the analyzer via the `targetGlobalSettings` parameter for a complete mapping table._"
    );
    lines.push("");
  } else {
    const entries = Object.entries(r.atjs.target_global_settings.values);
    lines.push(
      `Source: \`${r.atjs.target_global_settings.source}\` · ${entries.length} key(s) captured · ${r.atjs.target_global_settings.unmapped_keys.length} unmapped.`
    );
    lines.push("");
    lines.push("| Key | Value |");
    lines.push("|---|---|");
    for (const [k, v] of entries) {
      lines.push(`| \`${k}\` | ${escapeCell(stringifyShort(v))} |`);
    }
    lines.push("");
  }

  // Mboxes
  lines.push("### Mbox catalog");
  lines.push("");
  const m = r.atjs.mboxes;
  if (m.total_unique === 0) {
    lines.push(
      "_No mboxes detected from static HTML. at.js sites typically register mboxes at runtime — capture from a network trace (`tt.omtrdc.net/m2/...` requests) and re-run with `knownMboxes`._"
    );
    lines.push("");
  } else {
    lines.push(`**${m.total_unique} unique mbox(es) detected.**`);
    lines.push("");
    lines.push("| Mbox | Discovery source |");
    lines.push("|---|---|");
    const all = new Map<string, Set<string>>();
    for (const name of m.declarative_dom) {
      const s = all.get(name) ?? new Set();
      s.add("declarative DOM (`mbox=`/`data-mbox=`)");
      all.set(name, s);
    }
    for (const name of m.inline_calls) {
      const s = all.get(name) ?? new Set();
      s.add("inline call (`mboxCreate`/`getOffer`/etc.)");
      all.set(name, s);
    }
    for (const name of m.user_provided) {
      const s = all.get(name) ?? new Set();
      s.add("user-provided (network capture)");
      all.set(name, s);
    }
    for (const [name, sources] of Array.from(all.entries()).sort()) {
      lines.push(
        `| \`${name}\` | ${Array.from(sources).join("; ")} |`
      );
    }
    lines.push("");
  }

  // Prehiding
  lines.push("### Prehiding strategy");
  lines.push("");
  if (!r.atjs.prehiding.detected) {
    lines.push("_No prehiding CSS detected._");
    lines.push("");
  } else {
    lines.push(
      `**Style:** \`${r.atjs.prehiding.style}\`` +
        (r.atjs.prehiding.hidden_selectors.length > 0
          ? ` · **${r.atjs.prehiding.hidden_selectors.length} selector(s):** ${r.atjs.prehiding.hidden_selectors.map((s) => "`" + s + "`").join(", ")}`
          : "")
    );
    lines.push("");
    if (r.atjs.prehiding.raw_css) {
      lines.push("```css");
      lines.push(r.atjs.prehiding.raw_css);
      lines.push("```");
      lines.push("");
    }
  }

  // A4T
  lines.push("### A4T (Analytics for Target)");
  lines.push("");
  lines.push(
    `**Detected:** ${r.atjs.a4t.detected ? "yes" : "no"}` +
      (r.atjs.a4t.tracking_server
        ? ` · tracking server: \`${r.atjs.a4t.tracking_server}\``
        : "")
  );
  lines.push("");
  lines.push(`> ${r.atjs.a4t.note}`);
  lines.push("");
}

function renderMappings(lines: string[], r: AtjsAnalysisReport): void {
  lines.push("## 3. Migration mappings");
  lines.push("");

  if (r.migration_plan.auto_mappable.length === 0) {
    lines.push(
      "_No auto-mappable settings present (likely because `targetGlobalSettings` wasn't extracted). The Web SDK install will use orchestrator defaults._"
    );
    lines.push("");
  } else {
    lines.push(
      `**${r.migration_plan.auto_mappable.length} setting(s) auto-mappable:**`
    );
    lines.push("");
    lines.push(
      "| at.js setting | Source value | Web SDK target | Mapped value | Confidence |"
    );
    lines.push("|---|---|---|---|---|");
    for (const map of r.migration_plan.auto_mappable) {
      lines.push(
        `| \`${map.source.key}\` | ${escapeCell(stringifyShort(map.source.value))} | ${escapeCell(map.target.extension + ": " + map.target.field)} | ${escapeCell(stringifyShort(map.target.value))} | ${confidenceLabel(map.confidence)} |`
      );
    }
    lines.push("");

    // Confidence notes
    const lowConf = r.migration_plan.auto_mappable.filter(
      (m) => m.confidence === "low"
    );
    if (lowConf.length > 0) {
      lines.push(
        "**Low-confidence mappings (manual review required):**"
      );
      lines.push("");
      for (const m of lowConf) {
        lines.push(
          `- \`${m.source.key}\` — ${m.reason ?? "judgment call required"}`
        );
      }
      lines.push("");
    }
  }

  // Unmapped
  if (r.atjs.target_global_settings.unmapped_keys.length > 0) {
    lines.push(
      `**Unmapped keys (no Web SDK equivalent — review each):** ${r.atjs.target_global_settings.unmapped_keys.map((k) => "`" + k + "`").join(", ")}.`
    );
    lines.push("");
  }
}

function renderRecommendedCall(
  lines: string[],
  r: AtjsAnalysisReport,
  projectName: string
): void {
  lines.push("## 4. Recommended `setup_target_websdk` call");
  lines.push("");

  const rs = r.recommended_setup;
  const args: Record<string, unknown> = {
    datastreamName: projectName,
    propertyName: projectName,
    domains: [deriveDomainFromUrl(r.url)],
  };
  if (rs.targetClientCode) args.targetClientCode = rs.targetClientCode;
  if (rs.flickerSelectors && rs.flickerSelectors.length > 0)
    args.flickerSelectors = rs.flickerSelectors;
  if (rs.consentMode !== "in") args.consentMode = rs.consentMode;
  if (rs.includeA4t) args.includeA4t = true;

  lines.push(
    "Concrete invocation, copy-paste-ready. Adjust `datastreamName`/`propertyName`/`domains` for your environment naming convention before running:"
  );
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(args, null, 2));
  lines.push("```");
  lines.push("");

  if (rs.includeA4t) {
    lines.push(
      "**Follow-up call** (A4T detected — needs `reportSuites` + `trackingServer` that this analyzer can't infer from HTML):"
    );
    lines.push("");
    const a4tArgs: Record<string, unknown> = {
      datastreamId: "<from setup_target_websdk response>",
      reportSuites: ["<your-report-suite-id>"],
      trackingServer:
        r.atjs.a4t.tracking_server ?? "<your-tracking-server>",
    };
    lines.push("```json");
    lines.push(JSON.stringify(a4tArgs, null, 2));
    lines.push("```");
    lines.push("");
  }

  if (rs.decisionScopes_default.length > 0) {
    lines.push(
      "**Mbox → decisionScope strategy.** This analyzer detected the following mbox names. Each at.js mbox needs a Web SDK home:"
    );
    lines.push("");
    for (const scope of rs.decisionScopes_default) {
      lines.push(`- \`${scope}\``);
    }
    lines.push("");
    lines.push(
      "Pick one strategy per mbox:"
    );
    lines.push(
      "1. **Keep as scope name 1:1** — pass the mbox name unchanged as a decisionScope on the page-load `Send Event`. Simplest; preserves existing activity targeting. Default recommendation when in doubt."
    );
    lines.push(
      "2. **Consolidate to XDM view scopes** — replace many mboxes with a smaller set of `__view__` scopes per page-type. Cleaner long-term but requires activity-side rework — coordinate with whoever owns the Target activities."
    );
    lines.push(
      "3. **Drop the mbox** — if its activity is no longer active or has been superseded, don't carry the legacy name forward."
    );
    lines.push("");
  }
}

function renderStepPlan(lines: string[], r: AtjsAnalysisReport): void {
  lines.push("## 5. Step-by-step migration plan");
  lines.push("");

  const is1x = r.atjs.version === "1.x";

  lines.push("### Phase 1 — Prepare");
  lines.push("");
  lines.push("1. **Confirm Adobe credentials.** Verify the Dev Console integration has Reactor (Tags) + AEP product entitlements and the technical account has the relevant product profiles in Admin Console.");
  lines.push("2. **Snapshot the current state.** Take screenshots of: the live at.js page rendering, the Target Activities list (filtered to active), the current Tags property (if managed via Tags), and `targetGlobalSettings` from the browser console.");
  lines.push("3. **Decide cutover strategy.**" +
    (is1x
      ? " at.js 1.x is end-of-life — recommend a **clean cutover**: stand up the new Web SDK property, deploy on a test page, verify, then flip the embed when verified."
      : " at.js 2.x supports **parallel running** via Web SDK's `targetMigrationEnabled` flag. Useful for large sites where mbox call sites can't all be touched at once."));
  if (r.atjs.a4t.detected) {
    lines.push("4. **Coordinate with the Analytics owner.** A4T was detected — the Analytics extension on the new Tags property needs its own configuration, and the report suite must be wired into the Datastream's Analytics service. Confirm the report suite ID before proceeding.");
  }
  lines.push("");

  lines.push("### Phase 2 — Create the Web SDK foundation");
  lines.push("");
  lines.push("1. **Run the orchestrator call from §4 above.** This creates: an AEP Datastream with the Target service wired, a new Tags property with all 3 environments, the AEP Web SDK extension installed and configured with your datastream, the standard data elements (12 by default, 15 with A4T), and a page-load rule using Library Loaded + Guided Events.");
  lines.push("2. **Confirm the dev library built.** Check the orchestrator response's `library.build_status === 'succeeded'`. Build typically takes 20–60s.");
  if (r.atjs.a4t.detected) {
    lines.push("3. **Wire Analytics into the datastream.** Run the A4T follow-up call from §4. Verify with `validate_datastream`.");
  }
  lines.push((r.atjs.a4t.detected ? "4" : "3") + ". **Validate the property end-to-end.** Call `validate_tags_property` and `test_edge_network` (with `waitForPropagationSeconds: 90` since the datastream is fresh). Both should return `pass` for all critical checks.");
  lines.push("");

  lines.push("### Phase 3 — Deploy to staging");
  lines.push("");
  lines.push("1. **Pull the dev embed code from the orchestrator response** (`dev_embed_code` field). It looks like `<script src=\"https://assets.adobedtm.com/.../launch-...development.min.js\" async></script>`.");
  lines.push("2. **Add the embed to a non-production page.** Put it in `<head>`, **before** any other marketing tags, **before** the at.js script tag" +
    (is1x ? "" : " (or replace the at.js script if running clean cutover)") + ".");
  lines.push("3. **Open the page with `?adobe_mc_sdid=verify` in the URL.** This forces alloy to log verbosely to the console. Confirm: an Edge Network call to `/ee/v2/interact` is made, the call returns a 200, and the response contains `decisions: [...]` even if empty.");
  lines.push("4. **Confirm prehide isn't blocking content.** If `flickerSelectors` was used, the listed selectors should be `opacity: 0` briefly then snap visible. If the whole body blanks for >500ms, scope the prehide tighter.");
  lines.push("");

  lines.push("### Phase 4 — Cutover");
  lines.push("");
  if (is1x) {
    lines.push("1. **Activity recreation.** at.js 1.x activities don't carry forward automatically. The activities you want to keep need to be re-created in the new Web SDK property. Adobe's official Target MCP can help with the activity definitions.");
    lines.push("2. **Schedule the cutover window.** Plan for a brief blank-content window on the personalized regions during the swap. Communicate to stakeholders.");
    lines.push("3. **Flip the production embed.** Replace the at.js script tag with the new Web SDK production embed in the site's `<head>` template. Deploy.");
    lines.push("4. **Monitor for the first 24 hours.** Watch Target Reports for delivery counts and CTR. Compare to the at.js baseline from your snapshot.");
  } else {
    lines.push("1. **Decide on parallel-run window.** If running at.js 2.x in parallel with Web SDK: enable `targetMigrationEnabled` on both sides, then incrementally retire at.js call sites. The window is usually 2–4 weeks.");
    lines.push("2. **Activity coexistence.** Activities targeting at.js views need explicit Web SDK aliasing (or accept that they only fire from at.js until the activity is rewritten). Coordinate with whoever owns the Target activities.");
    lines.push("3. **Production embed change.** Once all activities are verified in Web SDK, drop the at.js script and remove the migration shims. The page should now run only on Web SDK.");
    lines.push("4. **Post-cutover validation.** Run `run_full_validation` against the property + datastream. Confirm Edge Network responsiveness, validation grade A or B.");
  }
  lines.push("");

  lines.push("### Phase 5 — Cleanup");
  lines.push("");
  lines.push("1. **Remove at.js artifacts from the codebase.** Delete `<script src=\"...at.js...\">` tags, `targetGlobalSettings` blocks, prehide CSS scoped to at.js classes (`.at-element-marker`), and any `mboxCreate` / `getOffer` call sites that have been replaced.");
  lines.push("2. **Deprecate the old Tags property** (if at.js was served via Tags). Mark it 'archived' rather than deleting — keeps the audit trail intact for 12 months.");
  lines.push("3. **Hand off documentation.** Save this runbook + the orchestrator response (containing datastream ID, property ID, environment embed codes) to the project's documentation. The next consultant will thank you.");
  lines.push("");
}

function renderDecisions(lines: string[], r: AtjsAnalysisReport): void {
  lines.push("## 6. Decisions required");
  lines.push("");
  if (r.migration_plan.manual_review.length === 0) {
    lines.push("_No manual decisions flagged. Migration can run on the orchestrator's defaults._");
    lines.push("");
    return;
  }
  for (const item of r.migration_plan.manual_review) {
    lines.push(`- [ ] ${item}`);
  }
  lines.push("");
}

function renderVerificationChecklist(
  lines: string[],
  r: AtjsAnalysisReport
): void {
  lines.push("## 7. Verification checklist");
  lines.push("");
  lines.push("Run through this after the cutover deploy:");
  lines.push("");
  lines.push("- [ ] `validate_tags_property` returns no critical failures");
  lines.push("- [ ] `validate_datastream` confirms Target service is `enabled: true`");
  lines.push("- [ ] `test_edge_network` returns `target_responding: true`");
  lines.push("- [ ] `check_website_implementation` against the deployed page returns `tags_embed_script_present: true`");
  lines.push("- [ ] Network trace shows a `/ee/v2/interact` call returning 200 on every page load");
  lines.push("- [ ] No `tt.omtrdc.net/m2/...` calls in the network trace (confirms at.js is fully removed; only applicable post-cutover)");
  if (r.atjs.prehiding.detected) {
    lines.push("- [ ] Prehide flicker window is < 500ms (eyeball check + DevTools Performance recording)");
  }
  if (r.atjs.a4t.detected) {
    lines.push("- [ ] Analytics + Target reports show overlapping experiment data for the same activity (A4T linkage working)");
  }
  if (r.recommended_setup.decisionScopes_default.length > 0) {
    lines.push(
      "- [ ] All " +
        r.recommended_setup.decisionScopes_default.length +
        " catalogued mbox/scope names are returning content for the activities that target them (compare to the at.js baseline)"
    );
  }
  lines.push("- [ ] No JS errors in the browser console on any test page");
  lines.push("- [ ] Re-run `analyze_atjs_implementation` against the post-cutover page — should now return `atjs.present: false`");
  lines.push("");
}

function renderAppendix(lines: string[], r: AtjsAnalysisReport): void {
  lines.push("## 8. Appendix — raw analysis");
  lines.push("");
  lines.push("Captured verbatim from `analyze_atjs_implementation` for reference / re-running.");
  lines.push("");
  lines.push("<details><summary>Click to expand JSON</summary>");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(r, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
}

// ── Helpers ─────────────────────────────────────────────────
function estimateEffort(r: AtjsAnalysisReport): string {
  let days = 1; // baseline
  if (r.atjs.version === "1.x") days += 1; // clean cutover overhead
  if (r.atjs.mboxes.total_unique >= 10) days += 1;
  if (r.atjs.mboxes.total_unique >= 25) days += 2;
  if (r.atjs.a4t.detected) days += 0.5;
  if (r.migration_plan.manual_review.length >= 5) days += 1;
  if (r.atjs.prehiding.style === "whole-body") days += 0.5;
  return `~${days} day${days === 1 ? "" : "s"} dev + 1 day QA`;
}

function analysisConfidence(r: AtjsAnalysisReport): string {
  const reasons: string[] = [];
  if (
    r.atjs.target_global_settings.detected &&
    r.atjs.target_global_settings.source === "inline-script"
  ) {
    reasons.push("settings extracted from inline HTML");
  } else if (r.atjs.target_global_settings.source === "user-provided") {
    reasons.push("settings supplied by user");
  } else {
    reasons.push("**settings missing**");
  }
  if (
    r.atjs.mboxes.total_unique > 0 &&
    (r.atjs.mboxes.user_provided.length > 0 ||
      r.atjs.mboxes.declarative_dom.length > 0)
  ) {
    reasons.push("mboxes catalogued");
  } else if (r.atjs.mboxes.total_unique === 0) {
    reasons.push("**no mboxes catalogued** (likely runtime-registered)");
  }
  const missing = reasons.filter((r) => r.includes("**")).length;
  const label =
    missing === 0 ? "**high**" : missing === 1 ? "medium" : "low";
  return `${label} — ${reasons.join("; ")}`;
}

function confidenceLabel(c: AtjsToWebSdkMapping["confidence"]): string {
  if (c === "high") return "**high**";
  if (c === "medium") return "medium";
  return "low";
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function stringifyShort(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "(unset)";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 77) + "…" : s;
  } catch {
    return String(v);
  }
}

function deriveProjectName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const cleaned = host.replace(/[^a-zA-Z0-9]+/g, "-");
    const today = new Date().toISOString().slice(0, 10);
    return `${cleaned}-websdk-${today}`;
  } catch {
    return `websdk-migration-${new Date().toISOString().slice(0, 10)}`;
  }
}

function deriveDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "example.com";
  }
}
