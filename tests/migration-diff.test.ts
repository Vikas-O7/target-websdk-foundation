/**
 * Tests for src/api/migration-diff.ts computeDiff (pure function).
 *
 * No network or Reactor calls. Drives synthetic AtjsAnalysisReport +
 * WebSdkState through computeDiff to cover every check branch.
 */
import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import { computeDiff } from "../src/api/migration-diff.js";
import type { AtjsAnalysisReport } from "../src/api/atjs-analysis.js";
import type { WebSdkState } from "../src/api/migration-diff.js";

// ── Fixture builders (deep-merge-safe overrides) ────────────
function atjsReport(overrides: Partial<AtjsAnalysisReport> & { atjs?: Partial<AtjsAnalysisReport["atjs"]> } = {}): AtjsAnalysisReport {
  const base: AtjsAnalysisReport = {
    url: "https://www.example.com/",
    http_status: 200,
    atjs: {
      present: true,
      version: "2.x",
      version_evidence: "Filename match: at.js-2.11.2",
      cdn_host: "assets.adobedtm.com",
      client_code: "examplecorp",
      library_url: "//assets.adobedtm.com/x/at.js-2.11.2.min.js",
      target_global_settings: {
        detected: true,
        source: "inline-script",
        values: { clientCode: "examplecorp", timeout: 5000 },
        unmapped_keys: [],
      },
      mboxes: {
        declarative_dom: ["hero"],
        inline_calls: ["pdp-recs"],
        user_provided: [],
        total_unique: 2,
      },
      prehiding: {
        detected: true,
        style: "scoped",
        raw_css: ".at-element-marker {opacity:0}",
        hidden_selectors: [".at-element-marker"],
      },
      a4t: { detected: false, tracking_server: null, note: "no A4T" },
      tags_bundle: {
        detected: false,
        url: null,
        followed: false,
        bundle_size_bytes: null,
        contained_atjs_markers: false,
      },
    },
    migration_plan: { auto_mappable: [], manual_review: [], blockers: [] },
    recommended_setup: {
      targetClientCode: "examplecorp",
      flickerSelectors: null,
      flickerStyle: null,
      consentMode: "in",
      decisionScopes_default: ["hero", "pdp-recs"],
      includeA4t: false,
      notes: [],
    },
    warnings: [],
    summary: "at.js 2.x · client=examplecorp · 2 mboxes",
  };
  if (overrides.atjs) base.atjs = { ...base.atjs, ...overrides.atjs };
  const { atjs: _ignore, ...restOverrides } = overrides;
  return { ...base, ...restOverrides };
}

function websdkState(overrides: Partial<WebSdkState> = {}): WebSdkState {
  const base: WebSdkState = {
    property_id: "PRtest123",
    property_name: "test-property",
    domains: ["www.example.com"],
    data_element_count: 12,
    data_element_names: [
      "Page - Name",
      "Page - URL",
      "XDM - Identity Map",
      "Target - Send Event Data",
      "Page - Type",
    ],
    rule_count: 1,
    page_load_rule_present: true,
    send_event_rules: [{ rule_name: "All Pages - Target WebSDK - Page Load", rule_id: "RL1" }],
    websdk_extension: {
      present: true,
      extension_id: "EX1",
      datastream_id: "ds-abc",
      flicker_style: ".alloy-prehiding { opacity: 0 }",
      default_consent: "in",
    },
    datastream: {
      id: "ds-abc",
      target_service_enabled: true,
      target_client_code: "examplecorp",
      analytics_service_enabled: false,
      analytics_report_suites: [],
    },
  };
  return { ...base, ...overrides };
}

// ── Tests ───────────────────────────────────────────────────
describe("computeDiff: happy path", () => {
  test("grade A, score >= 90, no critical failures", () => {
    const r = computeDiff(atjsReport(), websdkState());
    assert.equal(r.grade, "A");
    assert.ok(r.score >= 90);
    assert.equal(r.critical_failures.length, 0);
  });

  test("includes the core pass checks", () => {
    const r = computeDiff(atjsReport(), websdkState());
    const ids = [
      "websdk_extension_installed",
      "target_service_enabled",
      "client_code_match",
      "domain_coverage",
      "page_load_rule_present",
    ];
    for (const id of ids) {
      assert.ok(
        r.checks.some((c) => c.id === id && c.status === "pass"),
        `missing pass for ${id}`
      );
    }
  });

  test("emits info-level mbox_strategy_note when mboxes catalogued", () => {
    const r = computeDiff(atjsReport(), websdkState());
    assert.ok(r.checks.some((c) => c.id === "mbox_strategy_note" && c.status === "info"));
  });
});

describe("computeDiff: client code mismatch", () => {
  test("fails client_code_match check with recommendation", () => {
    const r = computeDiff(
      atjsReport({ atjs: { client_code: "oldclient" } }),
      websdkState({
        datastream: { ...websdkState().datastream!, target_client_code: "newclient" },
      })
    );
    const c = r.checks.find((x) => x.id === "client_code_match");
    assert.equal(c?.status, "fail");
    assert.equal(typeof c?.recommendation, "string");
    assert.ok(r.score < 100);
  });
});

describe("computeDiff: missing alloy extension (critical)", () => {
  test("grade F via critical floor", () => {
    const r = computeDiff(
      atjsReport(),
      websdkState({
        websdk_extension: {
          present: false,
          extension_id: null,
          datastream_id: null,
          flicker_style: null,
          default_consent: null,
        },
        datastream: null,
      })
    );
    assert.equal(r.grade, "F");
    assert.ok(r.critical_failures.some((s) => s.includes("Web SDK extension")));
  });
});

describe("computeDiff: A4T parity", () => {
  test("fails when at.js had A4T but Web SDK Analytics service not enabled", () => {
    const r = computeDiff(
      atjsReport({ atjs: { a4t: { detected: true, tracking_server: "x.sc.omtrdc.net", note: "A4T" } } }),
      websdkState()
    );
    const c = r.checks.find((x) => x.id === "a4t_match");
    assert.equal(c?.status, "fail");
    assert.equal(typeof c?.recommendation, "string");
  });

  test("passes when at.js had A4T AND Web SDK Analytics service enabled", () => {
    const r = computeDiff(
      atjsReport({ atjs: { a4t: { detected: true, tracking_server: "x.sc.omtrdc.net", note: "A4T" } } }),
      websdkState({
        datastream: {
          ...websdkState().datastream!,
          analytics_service_enabled: true,
          analytics_report_suites: ["rsid1"],
        },
      })
    );
    assert.ok(r.checks.some((c) => c.id === "a4t_match" && c.status === "pass"));
  });
});

describe("computeDiff: domain coverage", () => {
  test("warns when at.js host not in Web SDK domain list", () => {
    const r = computeDiff(
      atjsReport({ url: "https://shop.different-domain.com/" }),
      websdkState({ domains: ["www.example.com"] })
    );
    assert.ok(r.checks.some((c) => c.id === "domain_coverage" && c.status === "warn"));
  });

  test("passes via subdomain suffix-match", () => {
    const r = computeDiff(
      atjsReport({ url: "https://shop.example.com/" }),
      websdkState({ domains: ["example.com"] })
    );
    assert.ok(r.checks.some((c) => c.id === "domain_coverage" && c.status === "pass"));
  });
});

describe("computeDiff: data elements catalog", () => {
  test("warns when standard DE catalog incomplete", () => {
    const r = computeDiff(
      atjsReport(),
      websdkState({ data_element_names: ["Page - Name"] })
    );
    const c = r.checks.find((x) => x.id === "data_elements_complete");
    assert.equal(c?.status, "warn");
    assert.ok(c?.detail.includes("Target - Send Event Data"));
    assert.ok(c?.detail.includes("XDM - Identity Map"));
  });
});

describe("computeDiff: no page-load rule", () => {
  test("critical fail when no Send Event rule on property", () => {
    const r = computeDiff(
      atjsReport(),
      websdkState({ page_load_rule_present: false, send_event_rules: [] })
    );
    const c = r.checks.find((x) => x.id === "page_load_rule_present");
    assert.equal(c?.status, "fail");
    assert.ok(r.critical_failures.some((s) => s.includes("Page-load rule")));
  });
});

describe("computeDiff: unknown at.js client code", () => {
  test("info status (not a fail) when at.js client code can't be extracted", () => {
    const r = computeDiff(
      atjsReport({ atjs: { client_code: null } }),
      websdkState()
    );
    assert.equal(r.checks.find((c) => c.id === "client_code_match")?.status, "info");
  });
});

describe("computeDiff: zero mboxes", () => {
  test("no mbox_strategy_note check emitted when total_unique=0", () => {
    const r = computeDiff(
      atjsReport({
        atjs: {
          mboxes: { declarative_dom: [], inline_calls: [], user_provided: [], total_unique: 0 },
        },
      }),
      websdkState()
    );
    assert.ok(!r.checks.some((c) => c.id === "mbox_strategy_note"));
  });
});

describe("computeDiff: summary reflects severity", () => {
  test("happy state mentions 'covers all'", () => {
    const r = computeDiff(atjsReport(), websdkState());
    assert.ok(r.summary.includes("covers all"));
  });

  test("warn-only state mentions warning or cutover viable", () => {
    const r = computeDiff(
      atjsReport({ atjs: { a4t: { detected: true, tracking_server: null, note: "A4T" } } }),
      websdkState()
    );
    assert.ok(r.summary.includes("warning") || r.summary.includes("gap"));
  });

  test("critical-fail state mentions 'critical'", () => {
    const r = computeDiff(
      atjsReport(),
      websdkState({
        websdk_extension: {
          present: false,
          extension_id: null,
          datastream_id: null,
          flicker_style: null,
          default_consent: null,
        },
        datastream: null,
      })
    );
    assert.ok(r.summary.includes("critical"));
  });
});
