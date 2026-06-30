/**
 * Tests for src/api/atjs-analysis.ts.
 *
 * Spins up local HTTP servers serving synthetic at.js HTML fixtures, then
 * exercises the analyzer end-to-end. NO live network calls — deterministic
 * by design.
 */
import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { analyzeAtjsImplementation } from "../src/api/atjs-analysis.js";

// ── Fixtures ────────────────────────────────────────────────
const SAMPLES: Record<string, string> = {
  "/atjs-2-luma.html": `<!DOCTYPE html>
<html>
<head>
  <script>
    window.targetGlobalSettings = {
      clientCode: 'agsinternal',
      serverDomain: 'agsinternal.tt.omtrdc.net',
      timeout: 5000,
      crossDomain: 'disabled',
      cookieDomain: '.luma.example.com',
      optoutEnabled: false,
      defaultContentHiddenStyle: 'visibility: hidden',
      mboxPath: '/m2/agsinternal/mbox/standard',
      viewsEnabled: true,
      pageLoadEnabled: true,
      secureOnly: true,
      trackingServer: 'agsinternal.sc.omtrdc.net'
    };
  </script>
  <style>
    .at-element-marker { opacity: 0 !important }
    #hero-banner { opacity: 0 }
    .product-grid { opacity: 0 }
  </style>
  <script src="//assets.adobedtm.com/launch/EN1234/at.js-2.11.2.min.js"></script>
  <script src="//assets.adobedtm.com/AppMeasurement.js"></script>
</head>
<body>
  <div mbox="hero-mbox" data-mbox-defaults='{"version":"v2"}'>Default content</div>
  <div data-mbox="featured-products">Default products</div>
  <script>
    adobe.target.getOffer({
      mbox: 'pdp-recommendations',
      params: { productId: '12345' },
      success: function(offers) { /* ... */ }
    });
    mboxCreate('cart-upsell');
    if (window.s) { s.tl(true, 'o', 'target-event'); s_objectID = 'foo'; }
  </script>
</body>
</html>`,
  "/atjs-1-legacy.html": `<!DOCTYPE html>
<html>
<head>
  <script>
    targetGlobalSettings = {
      clientCode: "legacy",
      timeout: 3000,
      optoutEnabled: true
    };
  </script>
  <style>body { opacity: 0 !important }</style>
  <script src="//cdn.tt.omtrdc.net/legacy/at.js-1.8.2.js"></script>
</head>
<body>
  <script>
    mboxCreate("homepage-hero");
    mboxDefine("global-mbox-id", "global-mbox");
  </script>
</body>
</html>`,
  "/no-atjs.html": `<!DOCTYPE html><html><body><h1>nothing to see</h1></body></html>`,
};

// ── Test server lifecycle ──────────────────────────────────
let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((req, res) => {
    const html = req.url ? SAMPLES[req.url] : undefined;
    if (!html) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Tests ───────────────────────────────────────────────────
describe("analyzeAtjsImplementation: at.js 2.x synthetic fixture", () => {
  test("detects at.js 2.x via versioned filename", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-2-luma.html` });
    assert.equal(r.atjs.present, true);
    assert.equal(r.atjs.version, "2.x");
    assert.equal(r.atjs.client_code, "agsinternal");
    assert.ok(r.atjs.library_url?.includes("at.js-2.11.2"));
  });

  test("parses targetGlobalSettings: types coerced correctly", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-2-luma.html` });
    const v = r.atjs.target_global_settings.values;
    assert.equal(r.atjs.target_global_settings.detected, true);
    assert.equal(r.atjs.target_global_settings.source, "inline-script");
    assert.equal(v.clientCode, "agsinternal");
    assert.equal(v.timeout, 5000);
    assert.equal(v.optoutEnabled, false);
    assert.equal(v.trackingServer, "agsinternal.sc.omtrdc.net");
  });

  test("extracts mboxes from declarative DOM, inline calls, and user-provided", async () => {
    const r = await analyzeAtjsImplementation({
      url: `${baseUrl}/atjs-2-luma.html`,
      knownMboxes: ["network-captured-extra"],
    });
    assert.ok(r.atjs.mboxes.declarative_dom.includes("hero-mbox"));
    assert.ok(r.atjs.mboxes.declarative_dom.includes("featured-products"));
    assert.ok(r.atjs.mboxes.inline_calls.includes("pdp-recommendations"));
    assert.ok(r.atjs.mboxes.inline_calls.includes("cart-upsell"));
    assert.ok(r.atjs.mboxes.user_provided.includes("network-captured-extra"));
    assert.ok(r.atjs.mboxes.total_unique >= 5);
  });

  test("detects scoped prehide (not whole-body) with hidden_selectors", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-2-luma.html` });
    assert.equal(r.atjs.prehiding.detected, true);
    assert.equal(r.atjs.prehiding.style, "scoped");
    assert.ok(
      r.atjs.prehiding.hidden_selectors.some((s) => s.includes("hero-banner"))
    );
  });

  test("detects A4T with tracking server", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-2-luma.html` });
    assert.equal(r.atjs.a4t.detected, true);
    assert.equal(r.atjs.a4t.tracking_server, "agsinternal.sc.omtrdc.net");
  });

  test("auto-maps clientCode + trackingServer + flickerSelectors", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-2-luma.html` });
    const maps = r.migration_plan.auto_mappable;
    assert.ok(maps.some((m) => m.source.key === "clientCode" && m.target.extension === "datastream"));
    assert.ok(maps.some((m) => m.source.key === "trackingServer"));
    assert.equal(r.migration_plan.blockers.length, 0);
    assert.equal(r.recommended_setup.targetClientCode, "agsinternal");
    assert.equal(r.recommended_setup.includeA4t, true);
    assert.ok(Array.isArray(r.recommended_setup.flickerSelectors));
    assert.ok((r.recommended_setup.flickerSelectors?.length ?? 0) > 0);
  });
});

describe("analyzeAtjsImplementation: at.js 1.x legacy", () => {
  test("detects 1.x version + whole-body prehide", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-1-legacy.html` });
    assert.equal(r.atjs.version, "1.x");
    assert.equal(r.atjs.prehiding.style, "whole-body");
  });

  test("emits blocker for 1.x EOL", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-1-legacy.html` });
    assert.ok(r.migration_plan.blockers.length > 0);
    assert.ok(r.migration_plan.blockers[0].includes("1.x"));
  });

  test("optoutEnabled:true maps to consentMode:pending", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-1-legacy.html` });
    assert.equal(r.recommended_setup.consentMode, "pending");
  });

  test("manual review mentions whole-body prehide", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-1-legacy.html` });
    assert.ok(r.migration_plan.manual_review.some((s) => s.includes("Whole-body")));
  });

  test("extracts mboxes from mboxCreate + mboxDefine", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/atjs-1-legacy.html` });
    assert.ok(r.atjs.mboxes.inline_calls.includes("homepage-hero"));
    assert.ok(r.atjs.mboxes.inline_calls.includes("global-mbox"));
  });
});

describe("analyzeAtjsImplementation: no at.js page", () => {
  test("returns not-present with explanatory warning", async () => {
    const r = await analyzeAtjsImplementation({ url: `${baseUrl}/no-atjs.html` });
    assert.equal(r.atjs.present, false);
    assert.ok(r.warnings.length > 0);
  });
});
