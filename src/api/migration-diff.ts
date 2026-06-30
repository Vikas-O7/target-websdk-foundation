/**
 * at.js vs Web SDK implementation diff (v1.4).
 *
 * Cross-implementation verification: takes an at.js page URL + a Tags
 * property ID on the user's tenant, and reports the gaps between what
 * at.js was doing and what the new Web SDK property covers. Closes out
 * the migration toolkit:
 *
 *   1. analyze_atjs_implementation     — see at.js state
 *   2. migrate_atjs_to_websdk          — create Web SDK foundation
 *   3. generate_atjs_compat_shim       — keep call sites working
 *   4. diff_atjs_vs_websdk_implementation — verify the cutover ← THIS
 *
 * Two halves:
 *   • gatherWebSdkState(propertyId)  — Reactor + Edge Metadata calls
 *   • computeDiff(atjsReport, state) — pure diff logic (testable without
 *                                       any network calls)
 *
 * Checks are scoped to high-confidence misconfigurations: client code
 * mismatch, missing extensions/rules, missing A4T when expected, domain
 * gaps. We deliberately skip cosmetic comparisons (prehide style parity,
 * timeout values) because at.js → Web SDK isn't a literal port — those
 * differences are usually intentional.
 */

import {
  analyzeAtjsImplementation,
  type AtjsAnalysisReport,
  type AnalyzeAtjsInput,
} from "./atjs-analysis.js";
import type { JsonApiSingleResponse } from "./reactor-client.js";

// ── Types ───────────────────────────────────────────────────
export type DiffSeverity = "critical" | "error" | "warn" | "info";
export type DiffStatus = "pass" | "fail" | "warn" | "info";

export interface DiffCheck {
  id: string;
  category: "structure" | "client_code" | "domain" | "a4t" | "scopes";
  severity: DiffSeverity;
  status: DiffStatus;
  title: string;
  detail: string;
  recommendation?: string;
}

export interface WebSdkState {
  property_id: string;
  property_name: string;
  domains: string[];
  data_element_count: number;
  data_element_names: string[];
  rule_count: number;
  page_load_rule_present: boolean;
  send_event_rules: Array<{ rule_name: string; rule_id: string }>;
  websdk_extension: {
    present: boolean;
    extension_id: string | null;
    datastream_id: string | null;
    flicker_style: string | null;
    default_consent: string | null;
  };
  datastream: {
    id: string | null;
    target_service_enabled: boolean;
    target_client_code: string | null;
    analytics_service_enabled: boolean;
    analytics_report_suites: string[];
  } | null;
}

export interface DiffReport {
  url: string;
  property_id: string;
  atjs_summary: string;
  websdk_summary: string;
  checks: DiffCheck[];
  critical_failures: string[];
  warnings: string[];
  grade: "A" | "B" | "C" | "D" | "F";
  score: number;
  summary: string;
}

export interface DiffInput extends AnalyzeAtjsInput {
  /** Tags property ID for the Web SDK side. */
  propertyId: string;
  /** Optional override — useful when the Web SDK extension's datastreamId can't be parsed. */
  datastreamId?: string;
}

// ── Pure diff logic (testable without Reactor) ─────────────
export function computeDiff(
  atjs: AtjsAnalysisReport,
  websdk: WebSdkState
): DiffReport {
  const checks: DiffCheck[] = [];

  // ── Structure: Web SDK extension installed ──────────────
  checks.push(
    websdk.websdk_extension.present
      ? {
          id: "websdk_extension_installed",
          category: "structure",
          severity: "critical",
          status: "pass",
          title: "Web SDK extension installed",
          detail: `adobe-alloy extension present on the property (id: ${websdk.websdk_extension.extension_id}).`,
        }
      : {
          id: "websdk_extension_installed",
          category: "structure",
          severity: "critical",
          status: "fail",
          title: "Web SDK extension installed",
          detail:
            "adobe-alloy extension is NOT installed on the property. Web SDK can't deliver any decisions without it.",
          recommendation:
            "Run install_websdk_extension or re-run setup_target_websdk against this property.",
        }
  );

  // ── Structure: datastream wired ─────────────────────────
  if (websdk.websdk_extension.present) {
    checks.push(
      websdk.websdk_extension.datastream_id
        ? {
            id: "datastream_id_resolved",
            category: "structure",
            severity: "error",
            status: "pass",
            title: "Web SDK extension wired to a datastream",
            detail: `datastreamId: ${websdk.websdk_extension.datastream_id}`,
          }
        : {
            id: "datastream_id_resolved",
            category: "structure",
            severity: "error",
            status: "fail",
            title: "Web SDK extension wired to a datastream",
            detail:
              "Web SDK extension is installed but the datastreamId could not be extracted from its settings.",
            recommendation:
              "Re-install the Web SDK extension via install_websdk_extension with a valid datastreamId.",
          }
    );
  }

  // ── Structure: Target service enabled on the datastream ─
  if (websdk.datastream) {
    checks.push(
      websdk.datastream.target_service_enabled
        ? {
            id: "target_service_enabled",
            category: "structure",
            severity: "critical",
            status: "pass",
            title: "Target service enabled on the datastream",
            detail: "Datastream's Target service is enabled.",
          }
        : {
            id: "target_service_enabled",
            category: "structure",
            severity: "critical",
            status: "fail",
            title: "Target service enabled on the datastream",
            detail:
              "The datastream exists but the Target service is NOT enabled. Edge Network will not return Target decisions.",
            recommendation:
              "Run add_target_to_datastream against the datastream to enable Target.",
          }
    );
  }

  // ── Client code match ───────────────────────────────────
  const atjsClient = atjs.atjs.client_code;
  const websdkClient = websdk.datastream?.target_client_code ?? null;
  if (atjsClient && websdkClient) {
    if (atjsClient === websdkClient) {
      checks.push({
        id: "client_code_match",
        category: "client_code",
        severity: "error",
        status: "pass",
        title: "Target client code matches",
        detail: `Both sides use client code \`${atjsClient}\`.`,
      });
    } else {
      checks.push({
        id: "client_code_match",
        category: "client_code",
        severity: "error",
        status: "fail",
        title: "Target client code mismatch",
        detail: `at.js client \`${atjsClient}\` vs Web SDK datastream client \`${websdkClient}\`. Target tenants don't match — decisions will fire against the WRONG tenant.`,
        recommendation:
          "Either: (a) update the datastream's Target service to use the at.js client code, or (b) confirm the migration is intentionally moving tenants (rare).",
      });
    }
  } else if (atjsClient && !websdkClient) {
    checks.push({
      id: "client_code_match",
      category: "client_code",
      severity: "warn",
      status: "warn",
      title: "Web SDK client code not extracted",
      detail: `at.js side has client \`${atjsClient}\` but the Web SDK datastream's Target client code could not be read.`,
      recommendation:
        "Check the datastream's Target service settings via list_datastreams or validate_datastream.",
    });
  } else if (!atjsClient) {
    checks.push({
      id: "client_code_match",
      category: "client_code",
      severity: "info",
      status: "info",
      title: "at.js client code not extracted",
      detail:
        "at.js client code could not be inferred from the analyzed URL. Cross-check the value manually in the Adobe Target UI before cutover.",
    });
  }

  // ── Domain coverage ─────────────────────────────────────
  const atjsHost = (() => {
    try {
      return new URL(atjs.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (atjsHost && websdk.domains.length > 0) {
    const lowerDomains = websdk.domains.map((d) => d.toLowerCase());
    const matchExact = lowerDomains.includes(atjsHost);
    const matchSuffix = lowerDomains.some(
      (d) => atjsHost.endsWith(`.${d}`) || atjsHost === d
    );
    if (matchExact || matchSuffix) {
      checks.push({
        id: "domain_coverage",
        category: "domain",
        severity: "warn",
        status: "pass",
        title: "Web SDK property covers the at.js host",
        detail: `\`${atjsHost}\` matched by Web SDK property domain list: ${websdk.domains.join(", ")}.`,
      });
    } else {
      checks.push({
        id: "domain_coverage",
        category: "domain",
        severity: "warn",
        status: "warn",
        title: "at.js host not in Web SDK property domains",
        detail: `at.js was served from \`${atjsHost}\` but the Web SDK property's domain list (${websdk.domains.join(", ") || "empty"}) doesn't include it.`,
        recommendation:
          "Add the at.js host to the Web SDK property's domain list, OR confirm migration is intentionally moving the site to a different domain.",
      });
    }
  }

  // ── Page-load rule present ──────────────────────────────
  checks.push(
    websdk.page_load_rule_present
      ? {
          id: "page_load_rule_present",
          category: "structure",
          severity: "critical",
          status: "pass",
          title: "Page-load rule with Send Event present",
          detail: `Found ${websdk.send_event_rules.length} rule(s) firing a Send Event: ${websdk.send_event_rules.map((r) => `\`${r.rule_name}\``).join(", ")}.`,
        }
      : {
          id: "page_load_rule_present",
          category: "structure",
          severity: "critical",
          status: "fail",
          title: "Page-load rule with Send Event present",
          detail:
            "No rule on the property fires a Send Event action. Web SDK won't request any decisions from Edge Network without it.",
          recommendation:
            "Run create_standard_rules or re-run setup_target_websdk to create the v1.3 default page-load rule.",
        }
  );

  // ── A4T parity ──────────────────────────────────────────
  if (atjs.atjs.a4t.detected) {
    if (websdk.datastream?.analytics_service_enabled) {
      checks.push({
        id: "a4t_match",
        category: "a4t",
        severity: "error",
        status: "pass",
        title: "A4T parity: datastream Analytics service enabled",
        detail: `at.js had A4T markers; Web SDK datastream's Analytics service is enabled with ${websdk.datastream.analytics_report_suites.length} report suite(s).`,
      });
    } else if (websdk.datastream) {
      checks.push({
        id: "a4t_match",
        category: "a4t",
        severity: "error",
        status: "fail",
        title: "A4T expected but Analytics service NOT enabled",
        detail:
          "at.js side had A4T indicators (`trackingServer` or `s_objectID` near getOffer). The Web SDK datastream's Analytics service must be enabled with matching report suites for A4T reporting to continue working.",
        recommendation:
          "Run add_analytics_to_datastream with the report suite ID(s) from your AppMeasurement config.",
      });
    }
  }

  // ── Mbox strategy reminder ──────────────────────────────
  if (atjs.atjs.mboxes.total_unique > 0) {
    checks.push({
      id: "mbox_strategy_note",
      category: "scopes",
      severity: "info",
      status: "info",
      title: "Mbox → decisionScope strategy",
      detail: `${atjs.atjs.mboxes.total_unique} mbox(es) catalogued on the at.js side: ${atjs.atjs.mboxes.declarative_dom.concat(atjs.atjs.mboxes.inline_calls, atjs.atjs.mboxes.user_provided).slice(0, 8).join(", ")}${atjs.atjs.mboxes.total_unique > 8 ? "…" : ""}. The Web SDK side doesn't expose explicit decisionScopes on the default page-load rule — scopes are either implicit (via Guided Events) or carried per-call-site by the compat shim.`,
      recommendation:
        "If you deployed the compat shim, no action needed — each `getOffer(name)` call site passes the scope at runtime. If you didn't deploy the shim, confirm each mbox name maps to a Web SDK decisionScope strategy (1:1 with explicit scopes, or consolidated into XDM views).",
    });
  }

  // ── Data elements catalog ───────────────────────────────
  const expectedDEs = [
    "Page - Name",
    "Page - URL",
    "XDM - Identity Map",
    "Target - Send Event Data",
  ];
  const missingDEs = expectedDEs.filter(
    (n) => !websdk.data_element_names.includes(n)
  );
  if (missingDEs.length === 0) {
    checks.push({
      id: "data_elements_complete",
      category: "structure",
      severity: "warn",
      status: "pass",
      title: "Standard data element catalog present",
      detail: `Web SDK property has ${websdk.data_element_count} data element(s) including all v1.3 standard catalog members checked.`,
    });
  } else {
    checks.push({
      id: "data_elements_complete",
      category: "structure",
      severity: "warn",
      status: "warn",
      title: "Standard data element catalog incomplete",
      detail: `Missing v1.3 standard DEs: ${missingDEs.join(", ")}.`,
      recommendation:
        "Run sync_property_catalog against this property to backfill missing standard DEs.",
    });
  }

  // ── Compose grade + summary ─────────────────────────────
  const criticalFailures: string[] = [];
  const warnings: string[] = [];
  for (const c of checks) {
    if (c.status === "fail" && c.severity === "critical") {
      criticalFailures.push(c.title);
    } else if (c.status === "fail" || c.status === "warn") {
      if (c.severity === "warn" || c.severity === "info") {
        warnings.push(c.title);
      } else {
        criticalFailures.push(c.title);
      }
    }
  }

  // Score: start at 100, subtract per finding. Critical failures
  // additionally cap the final grade (no amount of passes redeems them).
  let score = 100;
  let hasCriticalFail = false;
  let errorFailCount = 0;
  for (const c of checks) {
    if (c.status === "fail") {
      if (c.severity === "critical") {
        score -= 30;
        hasCriticalFail = true;
      } else if (c.severity === "error") {
        score -= 15;
        errorFailCount++;
      } else if (c.severity === "warn") {
        score -= 5;
      }
    } else if (c.status === "warn") {
      score -= c.severity === "warn" ? 5 : 2;
    }
  }
  score = Math.max(0, score);

  // Grade with severity-cap floors
  let grade: DiffReport["grade"];
  if (hasCriticalFail) {
    grade = "F";
  } else if (errorFailCount >= 2) {
    grade = "D";
  } else if (errorFailCount === 1) {
    grade = score >= 75 ? "C" : "D";
  } else if (score >= 90) {
    grade = "A";
  } else if (score >= 80) {
    grade = "B";
  } else if (score >= 70) {
    grade = "C";
  } else if (score >= 60) {
    grade = "D";
  } else {
    grade = "F";
  }

  const atjsSummary = atjs.summary;
  const websdkSummary = [
    `${websdk.data_element_count} DE${websdk.data_element_count === 1 ? "" : "s"}`,
    `${websdk.rule_count} rule${websdk.rule_count === 1 ? "" : "s"}`,
    websdk.websdk_extension.present ? "alloy installed" : "alloy MISSING",
    websdk.datastream?.target_service_enabled
      ? "Target enabled"
      : "Target NOT enabled",
    websdk.datastream?.analytics_service_enabled ? "Analytics enabled" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const summary =
    criticalFailures.length > 0
      ? `${criticalFailures.length} critical gap(s) blocking the cutover.`
      : warnings.length > 0
        ? `${warnings.length} warning(s) — cutover viable but review before flipping production.`
        : "Web SDK property covers all at.js implementation signals checked.";

  return {
    url: atjs.url,
    property_id: websdk.property_id,
    atjs_summary: atjsSummary,
    websdk_summary: websdkSummary,
    checks,
    critical_failures: criticalFailures,
    warnings,
    grade,
    score,
    summary,
  };
}

// ── Web SDK state gatherer (Reactor + Edge Metadata) ───────
export async function gatherWebSdkState(
  propertyId: string,
  datastreamIdOverride?: string
): Promise<WebSdkState> {
  // Lazy-imported so the diff module + tests can use computeDiff
  // without triggering config.ts's stdio-mode env validation.
  const reactor = await import("./reactor-client.js");
  const datastreamsMod = await import("./datastreams.js");

  // Property metadata (domains)
  const propResp = await reactor.reactorRequest<JsonApiSingleResponse>(
    `/properties/${propertyId}`
  );
  const propName = (reactor.getAttr<string>(propResp, "name") ?? "") as string;
  const domains = (reactor.getAttr<string[]>(propResp, "domains") ?? []) as string[];

  // Extensions — find adobe-alloy
  const extensions = await reactor.reactorPaginate<{
    name?: string;
    settings?: string;
    enabled?: boolean;
  }>(`/properties/${propertyId}/extensions`);
  const alloy = extensions.find(
    (e) =>
      (e.attributes as { name?: string }).name === "adobe-alloy" ||
      (e.attributes as { extension_package_name?: string })
        .extension_package_name === "adobe-alloy"
  );
  let datastreamId: string | null = datastreamIdOverride ?? null;
  let flickerStyle: string | null = null;
  let defaultConsent: string | null = null;
  if (alloy) {
    try {
      const settingsStr = (alloy.attributes as { settings?: string }).settings ?? "{}";
      const settings = JSON.parse(settingsStr);
      const instance = Array.isArray(settings.instances) ? settings.instances[0] : null;
      if (instance) {
        if (!datastreamId && typeof instance.edgeConfigId === "string") {
          datastreamId = instance.edgeConfigId;
        }
        if (typeof instance.prehidingStyle === "string") {
          flickerStyle = instance.prehidingStyle;
        }
        if (typeof instance.defaultConsent === "string") {
          defaultConsent = instance.defaultConsent;
        }
      }
    } catch {
      /* malformed settings — leave fields null */
    }
  }

  // Data elements
  const dataElements = await reactor.reactorPaginate<{ name?: string }>(
    `/properties/${propertyId}/data_elements`
  );
  const deNames = dataElements
    .map((d) => (d.attributes as { name?: string }).name ?? "")
    .filter(Boolean);

  // Rules + Send Event action presence
  const rules = await reactor.reactorPaginate<{ name?: string }>(
    `/properties/${propertyId}/rules`
  );
  // For each rule, fetch its components and check for an alloy send-event action
  const sendEventRules: Array<{ rule_name: string; rule_id: string }> = [];
  for (const r of rules) {
    const ruleName = (r.attributes as { name?: string }).name ?? "";
    const components = await reactor.reactorPaginate<{
      delegate_descriptor_id?: string;
    }>(`/rules/${r.id}/rule_components`);
    const hasSendEvent = components.some((c) => {
      const d = (c.attributes as { delegate_descriptor_id?: string })
        .delegate_descriptor_id;
      return typeof d === "string" && /adobe-alloy::actions::send-event/.test(d);
    });
    if (hasSendEvent) sendEventRules.push({ rule_name: ruleName, rule_id: r.id });
  }

  // Datastream side — only fetch when we have an id
  let datastream: WebSdkState["datastream"] = null;
  if (datastreamId) {
    try {
      const detail = await datastreamsMod.getDatastreamDetail(datastreamId);
      const targetSvc = detail.services.find((s) => s.type === "Target");
      const analyticsSvc = detail.services.find((s) => s.type === "Analytics");
      const targetSettings = targetSvc?.settings as
        | { propertyToken?: string; clientCode?: string }
        | undefined;
      const analyticsSettings = analyticsSvc?.settings as
        | { reportSuites?: string[] }
        | undefined;
      datastream = {
        id: datastreamId,
        target_service_enabled: !!targetSvc?.enabled,
        target_client_code: targetSettings?.clientCode ?? null,
        analytics_service_enabled: !!analyticsSvc?.enabled,
        analytics_report_suites: analyticsSettings?.reportSuites ?? [],
      };
    } catch {
      datastream = {
        id: datastreamId,
        target_service_enabled: false,
        target_client_code: null,
        analytics_service_enabled: false,
        analytics_report_suites: [],
      };
    }
  }

  return {
    property_id: propertyId,
    property_name: propName,
    domains,
    data_element_count: dataElements.length,
    data_element_names: deNames,
    rule_count: rules.length,
    page_load_rule_present: sendEventRules.length > 0,
    send_event_rules: sendEventRules,
    websdk_extension: {
      present: !!alloy,
      extension_id: alloy?.id ?? null,
      datastream_id: datastreamId,
      flicker_style: flickerStyle,
      default_consent: defaultConsent,
    },
    datastream,
  };
}

// ── Public composer ─────────────────────────────────────────
export async function diffAtjsVsWebsdk(
  input: DiffInput
): Promise<DiffReport> {
  const atjs = await analyzeAtjsImplementation({
    url: input.url,
    knownMboxes: input.knownMboxes,
    targetGlobalSettings: input.targetGlobalSettings,
    fetchTimeoutMs: input.fetchTimeoutMs,
  });
  const websdk = await gatherWebSdkState(input.propertyId, input.datastreamId);
  return computeDiff(atjs, websdk);
}
