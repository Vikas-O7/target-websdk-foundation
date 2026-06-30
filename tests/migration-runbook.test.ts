/**
 * Tests for src/api/migration-runbook.ts.
 *
 * Drives the analyzer against a synthetic at.js 2.x fixture, then renders
 * the runbook and asserts on shape + key sections.
 */
import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { analyzeAtjsImplementation } from "../src/api/atjs-analysis.js";
import { generateMigrationRunbook } from "../src/api/migration-runbook.js";

const SAMPLE = `<!DOCTYPE html><html><head>
  <script>
    window.targetGlobalSettings = {
      clientCode: 'agsinternal',
      timeout: 5000,
      cookieDomain: '.luma.example.com',
      optoutEnabled: false,
      defaultContentHiddenStyle: 'visibility: hidden',
      trackingServer: 'agsinternal.sc.omtrdc.net',
      pageLoadEnabled: true,
      customSettingFooBar: 'unmapped'
    };
  </script>
  <style>
    .at-element-marker { opacity: 0 !important }
    #hero-banner { opacity: 0 }
    .product-grid { opacity: 0 }
  </style>
  <script src="//assets.adobedtm.com/launch/EN1234/at.js-2.11.2.min.js"></script>
  <script src="//assets.adobedtm.com/AppMeasurement.js"></script>
</head><body>
  <div mbox="hero-mbox">x</div>
  <div data-mbox="featured-products">x</div>
  <script>
    adobe.target.getOffer({mbox: 'pdp-recommendations'});
    mboxCreate('cart-upsell');
    s_objectID = 'foo';
  </script>
</body></html>`;

let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end(SAMPLE);
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("generateMigrationRunbook", () => {
  let md = "";

  before(async () => {
    const report = await analyzeAtjsImplementation({
      url: `${baseUrl}/`,
      knownMboxes: ["network-captured-extra-mbox"],
    });
    report.url = "https://www.luma.example.com/pdp/SKU12345";
    md = generateMigrationRunbook(report, { generatedAtIso: "2026-06-30" });
  });

  test("has title", () => {
    assert.ok(md.startsWith("# Adobe Target at.js → Web SDK"));
  });

  test("has all 8 section headers", () => {
    const headers = [
      "## 1. Executive summary",
      "## 2. Current state inventory",
      "## 3. Migration mappings",
      "## 4. Recommended `setup_target_websdk` call",
      "## 5. Step-by-step migration plan",
      "## 6. Decisions required",
      "## 7. Verification checklist",
      "## 8. Appendix",
    ];
    for (const h of headers) assert.ok(md.includes(h), `missing header: ${h}`);
  });

  test("renders concrete setup call with client code", () => {
    assert.ok(md.includes('"targetClientCode": "agsinternal"'));
  });

  test("includes A4T follow-up call when A4T detected", () => {
    assert.ok(md.includes("A4T detected — needs `reportSuites`"));
  });

  test("interpolates project name from URL host", () => {
    assert.ok(md.includes("luma-example-com-websdk"));
  });

  test("includes flickerSelectors in code sample", () => {
    assert.ok(md.includes("flickerSelectors"));
  });

  test("settings table includes pageLoadEnabled mapping", () => {
    assert.match(md, /\| `pageLoadEnabled` \|/);
  });

  test("unmapped key noted", () => {
    assert.ok(md.includes("customSettingFooBar"));
  });

  test("mbox catalog includes all 3 discovery sources", () => {
    assert.ok(md.includes("`hero-mbox`"));
    assert.ok(md.includes("`pdp-recommendations`"));
    assert.ok(md.includes("`network-captured-extra-mbox`"));
  });

  test("verification checklist references mbox count", () => {
    assert.match(md, /All \d+ catalogued mbox\/scope names/);
  });

  test("phase plan has 5 phases", () => {
    for (const p of ["### Phase 1", "### Phase 2", "### Phase 3", "### Phase 4", "### Phase 5"]) {
      assert.ok(md.includes(p), `missing ${p}`);
    }
  });

  test("cleanup phase mentions at-element-marker", () => {
    assert.ok(md.includes("at-element-marker"));
  });

  test("effort estimate present", () => {
    assert.match(md, /Estimated effort:.+day/);
  });

  test("appendix has collapsible JSON", () => {
    assert.ok(md.includes("<details><summary>Click to expand JSON</summary>"));
  });
});
