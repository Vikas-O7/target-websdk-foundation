/**
 * Data Collection — Validation tools.
 *
 * Five validators covering:
 *   1. Datastream config (structural — Platform API read)
 *   2. Tags property structure (Reactor API reads)
 *   3. Live Edge Network round-trip (REAL HTTP POST — no auth headers)
 *   4. Website HTML scrape (no browser — raw fetch + regex)
 *   5. Full validation suite — composes 1–4 + scoring
 *
 * Spec: Adobe Reactor / Edge Metadata API.
 */

import {
  reactorPaginate,
  reactorRequest,
  getAttr,
  type JsonApiSingleResponse,
} from "./reactor-client.js";
import { getDatastreamDetail } from "./datastreams.js";
import {
  EXTENSION_PACKAGE_NAMES,
  buildEdgeTestPayload,
  parseEdgeResponse,
  analyzeWebsiteHtml,
  type WebsiteImplChecks,
} from "./templates.js";

// ── Types ───────────────────────────────────────────────────
export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  check: string;
  status: CheckStatus;
  detail: string;
  severity?: "critical" | "error" | "warn" | "info";
}

export interface ValidationReport {
  checks: CheckResult[];
  overall: CheckStatus;
  critical_failures: string[];
  warnings: string[];
}

function aggregate(checks: CheckResult[]): {
  overall: CheckStatus;
  criticals: string[];
  warns: string[];
} {
  const criticals = checks
    .filter((c) => c.status === "fail" && c.severity === "critical")
    .map((c) => c.check);
  const warns = checks
    .filter((c) => c.status === "warn")
    .map((c) => c.check);
  const anyFail = checks.some((c) => c.status === "fail");
  const overall: CheckStatus =
    anyFail || criticals.length > 0
      ? "fail"
      : warns.length > 0
        ? "warn"
        : "pass";
  return { overall, criticals, warns };
}

// ── 1. Validate datastream ──────────────────────────────────
export async function validateDatastream(
  datastreamId: string
): Promise<ValidationReport & { datastream_id: string }> {
  const checks: CheckResult[] = [];
  let detail;
  try {
    detail = await getDatastreamDetail(datastreamId);
    checks.push({
      check: "Datastream exists",
      status: "pass",
      detail: `Found datastream ${detail.id} (${detail.name})`,
      severity: "critical",
    });
  } catch (e) {
    checks.push({
      check: "Datastream exists",
      status: "fail",
      detail: (e as Error).message,
      severity: "critical",
    });
    const agg = aggregate(checks);
    return {
      datastream_id: datastreamId,
      checks,
      overall: agg.overall,
      critical_failures: agg.criticals,
      warnings: agg.warns,
    };
  }

  const target = detail.services.find((s) => s.type === "Target");
  if (!target) {
    checks.push({
      check: "Target service present",
      status: "fail",
      detail: "No Target service configured on this datastream.",
      severity: "critical",
    });
  } else {
    checks.push({
      check: "Target service present",
      status: "pass",
      detail: "Target service is configured.",
      severity: "critical",
    });

    if (target.enabled) {
      checks.push({
        check: "Target service enabled",
        status: "pass",
        detail: "Target service is enabled.",
        severity: "critical",
      });
    } else {
      checks.push({
        check: "Target service enabled",
        status: "fail",
        detail: "Target service exists but is DISABLED.",
        severity: "critical",
      });
    }

    // Surface propertyToken configuration as informational. The legacy
    // "clientCode" check (from the original spec) was a false negative —
    // the modern Datastream API schema for the Target service is
    // {enabled, propertyToken?, environmentId?, thirdPartyIdNamespace?}
    // with NO clientCode field. Target tenant is derived from the IMS org.
    // Live confirmation 2026-06: a Target service with only enabled:true
    // produces a working personalization:decisions handle via Edge.
    const propertyToken = (target.settings as { propertyToken?: string })
      .propertyToken;
    checks.push({
      check: "Target property token configured",
      status: propertyToken ? "pass" : "warn",
      detail: propertyToken
        ? `propertyToken: ${propertyToken}`
        : "No propertyToken set. Optional, but recommended for workspace isolation in multi-property Target setups.",
      severity: "info",
    });

    const a4tEnabled = (target.settings as { a4tEnabled?: boolean }).a4tEnabled;
    const hasAnalytics = detail.services.some(
      (s) => s.type === "Analytics" && s.enabled
    );
    if (a4tEnabled && !hasAnalytics) {
      checks.push({
        check: "A4T consistency",
        status: "fail",
        detail: "a4tEnabled=true but Analytics service is not configured or not enabled on this datastream.",
        severity: "error",
      });
    } else {
      checks.push({
        check: "A4T consistency",
        status: "pass",
        detail: a4tEnabled
          ? "A4T enabled and Analytics service present."
          : "A4T disabled (normal — only enable if you need Analytics-sourced reporting).",
        severity: "info",
      });
    }

    const tgtMig = (target.settings as { targetMigrationEnabled?: boolean })
      .targetMigrationEnabled;
    if (tgtMig) {
      checks.push({
        check: "Target migration mode",
        status: "warn",
        detail: "targetMigrationEnabled=true — only correct if running at.js + Web SDK in parallel.",
        severity: "warn",
      });
    }
  }

  const agg = aggregate(checks);
  return {
    datastream_id: datastreamId,
    checks,
    overall: agg.overall,
    critical_failures: agg.criticals,
    warnings: agg.warns,
  };
}

// ── 2. Validate Tags property ──────────────────────────────
export async function validateTagsProperty(
  propertyId: string,
  expectedDatastreamId?: string
): Promise<ValidationReport & { property_id: string }> {
  const checks: CheckResult[] = [];

  // Property + extensions + DEs + rules in parallel
  let extensions: Array<{
    id: string;
    attributes: Record<string, unknown>;
  }> = [];
  let dataElements: Array<{ id: string; attributes: Record<string, unknown> }> = [];
  let rules: Array<{ id: string; attributes: Record<string, unknown> }> = [];
  let libraries: Array<{ id: string; attributes: Record<string, unknown> }> = [];
  try {
    [extensions, dataElements, rules, libraries] = await Promise.all([
      reactorPaginate(`/properties/${propertyId}/extensions`),
      reactorPaginate(`/properties/${propertyId}/data_elements`),
      reactorPaginate(`/properties/${propertyId}/rules`),
      reactorPaginate(`/properties/${propertyId}/libraries`),
    ]);
  } catch (e) {
    checks.push({
      check: "Property accessible",
      status: "fail",
      detail: (e as Error).message,
      severity: "critical",
    });
    const agg = aggregate(checks);
    return {
      property_id: propertyId,
      checks,
      overall: agg.overall,
      critical_failures: agg.criticals,
      warnings: agg.warns,
    };
  }

  // Web SDK extension
  const websdk = extensions.find(
    (e) =>
      ((e.attributes as { name?: string }).name === EXTENSION_PACKAGE_NAMES.websdk ||
        (e.attributes as { extension_package_name?: string }).extension_package_name === EXTENSION_PACKAGE_NAMES.websdk)
  );
  if (!websdk) {
    checks.push({
      check: "Web SDK extension installed",
      status: "fail",
      detail: `${EXTENSION_PACKAGE_NAMES.websdk} extension not found on this property.`,
      severity: "critical",
    });
  } else {
    checks.push({
      check: "Web SDK extension installed",
      status: "pass",
      detail: `${EXTENSION_PACKAGE_NAMES.websdk} found.`,
      severity: "critical",
    });
    const enabled = (websdk.attributes as { enabled?: boolean }).enabled;
    if (enabled !== false) {
      checks.push({
        check: "Web SDK extension enabled",
        status: "pass",
        detail: "Extension is enabled.",
        severity: "critical",
      });
    } else {
      checks.push({
        check: "Web SDK extension enabled",
        status: "fail",
        detail: "Web SDK extension exists but is disabled.",
        severity: "critical",
      });
    }

    if (expectedDatastreamId) {
      const settingsRaw = (websdk.attributes as { settings?: string }).settings;
      let actualDs: string | undefined;
      if (typeof settingsRaw === "string" && settingsRaw.length > 0) {
        try {
          const parsed = JSON.parse(settingsRaw);
          // Real shape: { instances: [{ edgeConfigId, ... }] }
          // Legacy fallback: { datastreamId }
          actualDs =
            parsed?.instances?.[0]?.edgeConfigId ?? parsed?.datastreamId;
        } catch {
          /* ignore */
        }
      }
      if (actualDs === expectedDatastreamId) {
        checks.push({
          check: "Datastream ID matches expected",
          status: "pass",
          detail: `datastreamId: ${actualDs}`,
          severity: "error",
        });
      } else {
        checks.push({
          check: "Datastream ID matches expected",
          status: "fail",
          detail: `Web SDK is wired to ${actualDs ?? "unknown"}, expected ${expectedDatastreamId}.`,
          severity: "error",
        });
      }
    }
  }

  // at.js conflict
  const atjs = extensions.find(
    (e) =>
      (e.attributes as { extension_package_name?: string }).extension_package_name === EXTENSION_PACKAGE_NAMES.target_atjs
  );
  if (atjs) {
    checks.push({
      check: "No at.js conflict",
      status: "warn",
      detail: "Legacy 'adobe-target' (at.js) extension is also installed. Migration-mode setup may be intentional; otherwise consider removing it.",
      severity: "warn",
    });
  }

  // XDM DE
  const xdmDe = dataElements.find((d) =>
    /xdm/i.test((d.attributes as { name?: string }).name ?? "")
  );
  if (xdmDe) {
    checks.push({
      check: "XDM data element exists",
      status: "pass",
      detail: `Found: ${(xdmDe.attributes as { name?: string }).name}`,
      severity: "warn",
    });
  } else {
    checks.push({
      check: "XDM data element exists",
      status: "warn",
      detail: "No data element with 'XDM' in the name was found. The Send Event action will lack an XDM payload.",
      severity: "warn",
    });
  }

  // Page load rule
  const pageLoadRule = rules.find((r) => {
    const n = (r.attributes as { name?: string }).name ?? "";
    return /page load|all pages/i.test(n);
  });
  if (!pageLoadRule) {
    checks.push({
      check: "Page load rule exists",
      status: "fail",
      detail: "No rule with 'Page Load' or 'All Pages' in the name was found.",
      severity: "critical",
    });
  } else {
    checks.push({
      check: "Page load rule exists",
      status: "pass",
      detail: `Found: ${(pageLoadRule.attributes as { name?: string }).name}`,
      severity: "critical",
    });
    // Drill into the rule's components to check Send Event and renderDecisions
    try {
      const comps = await reactorPaginate(
        `/rules/${pageLoadRule.id}/rule_components`
      );
      const sendEvent = comps.find(
        (c) =>
          (c.attributes as { delegate_descriptor_id?: string }).delegate_descriptor_id === "adobe-alloy::actions::send-event"
      );
      if (!sendEvent) {
        checks.push({
          check: "Page load rule has Send Event action",
          status: "fail",
          detail: "Page load rule found but no alloy Send Event action attached.",
          severity: "error",
        });
      } else {
        checks.push({
          check: "Page load rule has Send Event action",
          status: "pass",
          detail: "Send Event action attached.",
          severity: "error",
        });
        const settingsRaw = (sendEvent.attributes as { settings?: string }).settings;
        if (typeof settingsRaw === "string") {
          try {
            const parsed = JSON.parse(settingsRaw);
            if (parsed.renderDecisions === true) {
              checks.push({
                check: "renderDecisions enabled on Send Event",
                status: "pass",
                detail: "renderDecisions: true",
                severity: "warn",
              });
            } else {
              checks.push({
                check: "renderDecisions enabled on Send Event",
                status: "warn",
                detail: `renderDecisions: ${parsed.renderDecisions} — Target activities will not auto-render without this.`,
                severity: "warn",
              });
            }
          } catch {
            checks.push({
              check: "renderDecisions enabled on Send Event",
              status: "warn",
              detail: "Could not parse Send Event settings JSON.",
              severity: "warn",
            });
          }
        }

        // Event component: DOM Ready or Window Loaded
        const eventComp = comps.find((c) => {
          const desc =
            (c.attributes as { delegate_descriptor_id?: string }).delegate_descriptor_id ?? "";
          return /core::events::/.test(desc);
        });
        if (eventComp) {
          const desc =
            (eventComp.attributes as { delegate_descriptor_id?: string }).delegate_descriptor_id ?? "";
          const isDomOrLoaded =
            desc === "core::events::dom-ready" ||
            desc === "core::events::window-loaded" ||
            desc === "core::events::library-loaded";
          if (isDomOrLoaded) {
            checks.push({
              check: "Page load rule fires on DOM ready / window loaded",
              status: "pass",
              detail: `Event: ${desc.split("::").pop()}`,
              severity: "error",
            });
          } else {
            checks.push({
              check: "Page load rule fires on DOM ready / window loaded",
              status: "warn",
              detail: `Event: ${desc} — non-standard for a page-load rule.`,
              severity: "warn",
            });
          }
        }
      }
    } catch (e) {
      checks.push({
        check: "Page load rule has Send Event action",
        status: "warn",
        detail: `Could not fetch rule components: ${(e as Error).message}`,
        severity: "warn",
      });
    }
  }

  // Dev library built?
  const devLib = libraries.find(
    (l) =>
      (l.attributes as { state?: string }).state === "development"
  );
  if (devLib) {
    checks.push({
      check: "Development library exists",
      status: "pass",
      detail: `Library: ${(devLib.attributes as { name?: string }).name ?? devLib.id}`,
      severity: "warn",
    });
  } else {
    checks.push({
      check: "Development library exists",
      status: "warn",
      detail: "No development-stage library found. Run create_dev_library.",
      severity: "warn",
    });
  }

  const agg = aggregate(checks);
  return {
    property_id: propertyId,
    checks,
    overall: agg.overall,
    critical_failures: agg.criticals,
    warnings: agg.warns,
  };
}

// ── 3. Live Edge Network test ──────────────────────────────
export interface EdgeTestResult {
  datastream_id: string;
  test_ecid: string;
  request_id: string;
  http_status: number;
  checks: {
    edge_reachable: boolean;
    identity_assigned: boolean;
    target_responding: boolean;
    target_has_activities: boolean;
    location_hint_returned: boolean;
  };
  interpretation: Record<string, string>;
  target_decisions_raw: unknown[];
  raw_handle_types: string[];
  overall_status: CheckStatus;
  summary: string;
  /** Whether the result was reached after waiting for Edge propagation. */
  propagation_retries?: number;
  /** Seconds slept waiting for propagation across all retries. */
  propagation_wait_seconds?: number;
}

const EDGE_INTERACT_URL = "https://edge.adobedc.net/ee/v2/interact";

export interface EdgeTestOptions {
  /**
   * Maximum total seconds to wait for Edge propagation when the datastream
   * is reachable + identity works but Target hasn't started responding yet
   * (typical for datastreams created in the last ~60 seconds). Default 0
   * (no waiting). Recommended: 90 after `create_datastream` +
   * `add_target_to_datastream`.
   */
  waitForPropagationSeconds?: number;
  /** Seconds between propagation retries. Default 15. */
  pollIntervalSeconds?: number;
}

async function runEdgeProbe(
  datastreamId: string,
  testPageName: string,
  testUrl: string
): Promise<EdgeTestResult> {
  const { payload, requestId, testEcid } = buildEdgeTestPayload(
    testPageName,
    testUrl
  );
  const url = new URL(EDGE_INTERACT_URL);
  url.searchParams.set("dataStreamId", datastreamId);
  url.searchParams.set("requestId", requestId);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return {
      datastream_id: datastreamId,
      test_ecid: testEcid,
      request_id: requestId,
      http_status: 0,
      checks: {
        edge_reachable: false,
        identity_assigned: false,
        target_responding: false,
        target_has_activities: false,
        location_hint_returned: false,
      },
      interpretation: {
        edge_reachable: `❌ Network error: ${(e as Error).message}`,
      },
      target_decisions_raw: [],
      raw_handle_types: [],
      overall_status: "fail",
      summary: `Could not reach the Adobe Edge Network: ${(e as Error).message}`,
    };
  }

  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* leave as {} */
  }

  if (!res.ok) {
    return {
      datastream_id: datastreamId,
      test_ecid: testEcid,
      request_id: requestId,
      http_status: res.status,
      checks: {
        edge_reachable: false,
        identity_assigned: false,
        target_responding: false,
        target_has_activities: false,
        location_hint_returned: false,
      },
      interpretation: {
        edge_reachable: `❌ Edge Network returned HTTP ${res.status}: ${text.slice(0, 300)}`,
      },
      target_decisions_raw: [],
      raw_handle_types: [],
      overall_status: "fail",
      summary: `Edge Network rejected the request (HTTP ${res.status}). Check that the datastream ID is correct and the datastream is enabled.`,
    };
  }

  const p = parseEdgeResponse(parsed);
  const checks = {
    edge_reachable: p.edgeResponded,
    identity_assigned: p.identityAssigned,
    target_responding: p.targetResponding,
    target_has_activities: p.targetActivityCount > 0,
    location_hint_returned: p.locationHint !== null,
  };

  const interpretation: Record<string, string> = {
    edge_reachable: checks.edge_reachable
      ? "✅ Adobe Edge Network is reachable."
      : "❌ Edge Network unreachable.",
    identity_assigned: checks.identity_assigned
      ? "✅ ECID identity service is working."
      : "⚠️ No identity result returned — unusual but may not indicate a problem.",
    target_responding: checks.target_responding
      ? "✅ Adobe Target is connected and responding via this datastream."
      : "❌ Adobe Target did not respond — check Target service is enabled on the datastream and the client code is correct.",
    target_has_activities: checks.target_has_activities
      ? `✅ Target returned ${p.targetActivityCount} decision(s).`
      : "⚠️ Target responded but returned no activities. This is NORMAL if no active activity targets the test URL. The connection is working — deploy a real activity to see propositions.",
    location_hint_returned: checks.location_hint_returned
      ? `✅ Edge routing working (location hint: ${p.locationHint}).`
      : "⚠️ No location hint returned.",
  };

  let overall: CheckStatus = "pass";
  if (!checks.edge_reachable || !checks.target_responding) overall = "fail";
  else if (!checks.identity_assigned || !checks.location_hint_returned)
    overall = "warn";

  const summary =
    overall === "pass"
      ? "Target Web SDK datastream is configured correctly and responding via the Edge Network."
      : overall === "warn"
        ? "Edge Network responded but some signals are missing — see interpretation."
        : "Edge Network test failed — see interpretation for the failing check.";

  return {
    datastream_id: datastreamId,
    test_ecid: testEcid,
    request_id: requestId,
    http_status: res.status,
    checks,
    interpretation,
    target_decisions_raw: parsed && typeof parsed === "object" && "handle" in parsed
      ? (() => {
          const handle = (parsed as { handle?: unknown[] }).handle ?? [];
          const decisions = handle.find(
            (h) => (h as { type?: string }).type === "personalization:decisions"
          );
          return (
            (decisions as { payload?: unknown[] } | undefined)?.payload ?? []
          );
        })()
      : [],
    raw_handle_types: p.rawHandleTypes,
    overall_status: overall,
    summary,
  };
}

/**
 * Public Edge test entry point. Runs the probe once; if Target hasn't
 * propagated yet but everything else is healthy, polls until success or
 * the wait budget is exhausted.
 *
 * Edge Network needs ~30-60 seconds to sync a newly-created datastream
 * (or a service activation on an existing one). Without retry, every
 * "I just created this datastream, why doesn't Target respond?" looks
 * like a configuration bug. With retry, the tool blocks until Target
 * really is online — which is what the consultant actually wants to know.
 *
 * Retry only fires on the specific "Target not responding yet but
 * everything else is healthy" pattern. Hard failures (HTTP 4xx, missing
 * identity, unreachable edge) return immediately — retrying won't help.
 */
export async function testEdgeNetwork(
  datastreamId: string,
  testPageName = "MCP Validation Test",
  testUrl = "https://mcp-validation.local",
  options: EdgeTestOptions = {}
): Promise<EdgeTestResult> {
  const waitBudgetSec = Math.max(0, options.waitForPropagationSeconds ?? 0);
  const pollIntervalSec = Math.max(5, options.pollIntervalSeconds ?? 15);

  let result = await runEdgeProbe(datastreamId, testPageName, testUrl);
  if (waitBudgetSec === 0) return result;

  // Eligible to retry only if it looks like a propagation-lag pattern.
  const looksLikePropagationLag = (r: EdgeTestResult): boolean =>
    r.http_status === 200 &&
    r.checks.edge_reachable === true &&
    r.checks.identity_assigned === true &&
    r.checks.target_responding === false;

  if (!looksLikePropagationLag(result)) return result;

  let elapsedSec = 0;
  let retries = 0;
  while (elapsedSec < waitBudgetSec && looksLikePropagationLag(result)) {
    const sleepSec = Math.min(pollIntervalSec, waitBudgetSec - elapsedSec);
    await new Promise((r) => setTimeout(r, sleepSec * 1000));
    elapsedSec += sleepSec;
    retries += 1;
    result = await runEdgeProbe(datastreamId, testPageName, testUrl);
  }

  result.propagation_retries = retries;
  result.propagation_wait_seconds = elapsedSec;
  if (result.checks.target_responding) {
    result.summary =
      `Target Web SDK datastream is configured correctly and responding via the Edge Network ` +
      `(after ${elapsedSec}s propagation wait, ${retries} retr${retries === 1 ? "y" : "ies"}).`;
  } else if (looksLikePropagationLag(result)) {
    result.summary =
      `Edge reachable and identity working, but Target still not responding after ${elapsedSec}s. ` +
      `Either propagation needs more time (try waitForPropagationSeconds: 180), ` +
      `or the Target service on this datastream is misconfigured.`;
  }
  return result;
}

// ── 4. Website HTML check ──────────────────────────────────
export interface WebsiteCheckResult {
  website_url: string;
  http_status: number;
  checks: WebsiteImplChecks;
  warnings: string[];
  overall: CheckStatus;
  summary: string;
}

export async function checkWebsiteImplementation(
  websiteUrl: string,
  expectedScriptUrl?: string
): Promise<WebsiteCheckResult> {
  let res: Response;
  try {
    res = await fetch(websiteUrl, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (Mcp-Validator)" },
      redirect: "follow",
    });
  } catch (e) {
    return {
      website_url: websiteUrl,
      http_status: 0,
      checks: {
        tagsEmbedPresent: false,
        foundTagsUrl: null,
        correctScriptUrl: null,
        scriptIsAsync: false,
        atjsConflictDetected: false,
        mcidConflictDetected: false,
        acdlPresent: false,
        alloyDirectInclude: false,
      },
      warnings: [],
      overall: "fail",
      summary: `Could not fetch ${websiteUrl}: ${(e as Error).message}`,
    };
  }

  const html = await res.text();
  const checks = analyzeWebsiteHtml(html, expectedScriptUrl);

  const warnings: string[] = [];
  if (checks.atjsConflictDetected)
    warnings.push("at.js conflict detected — legacy Target library is loaded on this page.");
  if (checks.mcidConflictDetected)
    warnings.push(
      "Legacy MCID / Visitor API detected — consider removing if migrating to Web SDK."
    );
  if (checks.tagsEmbedPresent && !checks.scriptIsAsync)
    warnings.push(
      "Tags embed script is present but not loaded with `async` attribute."
    );
  if (checks.correctScriptUrl === false)
    warnings.push(
      "Tags embed present but does NOT match the expected script URL."
    );

  let overall: CheckStatus = "pass";
  if (!checks.tagsEmbedPresent || checks.atjsConflictDetected) overall = "fail";
  else if (warnings.length > 0) overall = "warn";

  const summary =
    overall === "pass"
      ? "Tags embed code is correctly deployed. No conflicts detected."
      : overall === "warn"
        ? `Tags embed is deployed but ${warnings.length} concern(s) flagged.`
        : !checks.tagsEmbedPresent
          ? "Tags embed code was NOT found on this URL."
          : "Tags embed deployed alongside a conflicting legacy library.";

  return {
    website_url: websiteUrl,
    http_status: res.status,
    checks,
    warnings,
    overall,
    summary,
  };
}

// ── 5. Full validation suite ───────────────────────────────
export interface FullValidationResult {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  sections: {
    datastream: ValidationReport & { datastream_id: string };
    tags_property: ValidationReport & { property_id: string };
    edge_network_live_test: EdgeTestResult;
    website?: WebsiteCheckResult;
  };
  critical_failures: string[];
  warnings: string[];
  recommended_actions: string[];
  summary: string;
}

function scoreAndGrade(sections: {
  ds: ValidationReport;
  tp: ValidationReport;
  edge: EdgeTestResult;
  web?: WebsiteCheckResult;
}): { score: number; grade: FullValidationResult["grade"] } {
  // Simple weighted score:
  //   datastream: 30%, tags property: 30%, edge: 30%, website: 10%
  const sectionScore = (status: CheckStatus): number =>
    status === "pass" ? 100 : status === "warn" ? 70 : 0;
  const ds = sectionScore(sections.ds.overall);
  const tp = sectionScore(sections.tp.overall);
  const ed = sectionScore(sections.edge.overall_status);
  const wb = sections.web ? sectionScore(sections.web.overall) : 100;
  const score = Math.round(ds * 0.3 + tp * 0.3 + ed * 0.3 + wb * 0.1);
  const grade: FullValidationResult["grade"] =
    score >= 95 ? "A" : score >= 85 ? "B" : score >= 70 ? "C" : score >= 50 ? "D" : "F";
  return { score, grade };
}

export async function runFullValidation(input: {
  datastreamId: string;
  propertyId: string;
  websiteUrl?: string;
  expectedScriptUrl?: string;
}): Promise<FullValidationResult> {
  const [ds, tp, edge] = await Promise.all([
    validateDatastream(input.datastreamId),
    validateTagsProperty(input.propertyId, input.datastreamId),
    testEdgeNetwork(input.datastreamId),
  ]);
  const web = input.websiteUrl
    ? await checkWebsiteImplementation(input.websiteUrl, input.expectedScriptUrl)
    : undefined;

  const { score, grade } = scoreAndGrade({ ds, tp, edge, web });

  const criticals = [
    ...ds.critical_failures.map((c) => `[datastream] ${c}`),
    ...tp.critical_failures.map((c) => `[tags] ${c}`),
  ];
  if (edge.overall_status === "fail")
    criticals.push("[edge] live edge test failed");
  if (web?.overall === "fail") criticals.push("[website] embed/conflict check failed");

  const warnings = [
    ...ds.warnings.map((w) => `[datastream] ${w}`),
    ...tp.warnings.map((w) => `[tags] ${w}`),
    ...(web?.warnings ?? []).map((w) => `[website] ${w}`),
  ];

  const recommended: string[] = [];
  if (tp.checks.find((c) => c.check === "renderDecisions enabled on Send Event" && c.status === "warn"))
    recommended.push(
      "Set renderDecisions: true in the Send Event action of your page load rule so Target activities auto-render."
    );
  if (tp.checks.find((c) => c.check === "Development library exists" && c.status === "warn"))
    recommended.push("Run create_dev_library to produce a buildable dev embed code.");
  if (edge.checks.target_responding && !edge.checks.target_has_activities && !input.websiteUrl)
    recommended.push(
      "Once an activity is live in Target targeting the real domain, call check_website_implementation against that URL."
    );

  const summary =
    grade === "A"
      ? "Implementation is working end-to-end. Target is connected and responding via the Edge Network."
      : grade === "B"
        ? "Mostly healthy with minor improvements recommended."
        : grade === "C"
          ? "Working but multiple issues need attention."
          : "Critical issues blocking a working setup — see critical_failures.";

  return {
    score,
    grade,
    sections: {
      datastream: ds,
      tags_property: tp,
      edge_network_live_test: edge,
      website: web,
    },
    critical_failures: criticals,
    warnings,
    recommended_actions: recommended,
    summary,
  };
}

// Internal symbol kept to satisfy unused-import linter for future use.
void reactorRequest;
void getAttr;
void (null as JsonApiSingleResponse | null);
