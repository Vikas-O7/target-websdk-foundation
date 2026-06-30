/**
 * Tests for src/api/migrate-atjs.ts (one-shot migrator).
 *
 * Dry-run only — never calls setupTargetWebsdk against a live tenant from
 * this suite. Covers happy path, refuse-on-blocker, force-blockers,
 * missing-client-code refusal, override, and includeRunbook flag.
 */
import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { migrateAtjsToWebsdk } from "../src/api/migrate-atjs.js";

const SAMPLES: Record<string, string> = {
  "/atjs-2-clean.html": `<!DOCTYPE html><html><head>
    <script>
      window.targetGlobalSettings = {
        clientCode: 'demo-client',
        timeout: 5000,
        optoutEnabled: false,
        defaultContentHiddenStyle: 'visibility: hidden'
      };
    </script>
    <style>.at-element-marker { opacity: 0 !important } #hero { opacity: 0 } .product-grid { opacity: 0 }</style>
    <script src="//assets.adobedtm.com/launch/EN1234/at.js-2.11.2.min.js"></script>
  </head><body>
    <div mbox="hero">x</div>
    <script>mboxCreate('cart-upsell');</script>
  </body></html>`,
  "/atjs-1-legacy.html": `<!DOCTYPE html><html><head>
    <script>targetGlobalSettings = { clientCode: "legacy" };</script>
    <script src="//cdn.tt.omtrdc.net/at.js-1.8.2.js"></script>
  </head><body><script>mboxCreate("hero");</script></body></html>`,
  "/no-atjs.html": `<!DOCTYPE html><html><body><h1>nothing</h1></body></html>`,
};

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

describe("migrateAtjsToWebsdk: dry-run happy path (at.js 2.x)", () => {
  test("dryRun defaults to true; no setup_result emitted", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-2-clean.html`,
      propertyName: "demo-site-websdk-2026-06-30",
      domains: ["demo-site.example.com"],
    });
    assert.equal(r.dry_run, true);
    assert.equal(r.status, "analyzed_dry_run");
    assert.equal(r.setup_result, null);
    assert.equal(r.refusal_reason, null);
  });

  test("analysis is populated", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-2-clean.html`,
      propertyName: "demo-websdk",
      domains: ["demo.example.com"],
    });
    assert.equal(r.analysis.atjs.present, true);
  });

  test("planned_setup_call has client code + property name", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-2-clean.html`,
      propertyName: "demo-site-websdk-2026-06-30",
      domains: ["demo-site.example.com"],
    });
    assert.equal(r.planned_setup_call.targetClientCode, "demo-client");
    assert.equal(r.planned_setup_call.propertyName, "demo-site-websdk-2026-06-30");
  });

  test("flickerSelectors populated from scoped prehide", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-2-clean.html`,
      propertyName: "x",
      domains: ["x.example.com"],
    });
    assert.ok(Array.isArray(r.planned_setup_call.flickerSelectors));
    assert.ok((r.planned_setup_call.flickerSelectors?.length ?? 0) >= 2);
  });

  test("runbook included by default", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-2-clean.html`,
      propertyName: "x",
      domains: ["x.example.com"],
    });
    assert.equal(typeof r.runbook_markdown, "string");
    assert.ok((r.runbook_markdown?.length ?? 0) > 5000);
  });

  test("next_steps mentions dryRun:false transition", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-2-clean.html`,
      propertyName: "x",
      domains: ["x.example.com"],
    });
    assert.ok(r.next_steps.some((s) => s.includes("dryRun:false")));
  });
});

describe("migrateAtjsToWebsdk: refuses on at.js 1.x blockers", () => {
  test("status: refused_blockers_present", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-1-legacy.html`,
      propertyName: "legacy-websdk",
      domains: ["legacy.example.com"],
    });
    assert.equal(r.status, "refused_blockers_present");
    assert.notEqual(r.refusal_reason, null);
    assert.ok(r.refusal_reason!.includes("blocker"));
  });

  test("setup_result null when refused", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-1-legacy.html`,
      propertyName: "x",
      domains: ["x.example.com"],
    });
    assert.equal(r.setup_result, null);
  });

  test("next_steps mentions forceBlockers escape hatch", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-1-legacy.html`,
      propertyName: "x",
      domains: ["x.example.com"],
    });
    assert.ok(r.next_steps.some((s) => s.includes("forceBlockers")));
  });

  test("runbook still included on refusal", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-1-legacy.html`,
      propertyName: "x",
      domains: ["x.example.com"],
    });
    assert.equal(typeof r.runbook_markdown, "string");
    assert.ok((r.runbook_markdown?.length ?? 0) > 1000);
  });
});

describe("migrateAtjsToWebsdk: forceBlockers override", () => {
  test("status: analyzed_dry_run when forceBlockers:true", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-1-legacy.html`,
      propertyName: "legacy-forced-websdk",
      domains: ["legacy.example.com"],
      forceBlockers: true,
    });
    assert.equal(r.status, "analyzed_dry_run");
    assert.equal(r.planned_setup_call.targetClientCode, "legacy");
  });
});

describe("migrateAtjsToWebsdk: refuses on missing client code", () => {
  test("status: refused_missing_client_code (no at.js, no override)", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/no-atjs.html`,
      propertyName: "x-websdk",
      domains: ["x.example.com"],
    });
    assert.equal(r.status, "refused_missing_client_code");
    assert.equal(r.setup_result, null);
  });

  test("targetClientCode override unblocks proceed", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/no-atjs.html`,
      propertyName: "fresh-websdk",
      domains: ["fresh.example.com"],
      targetClientCode: "manualcode",
    });
    assert.equal(r.status, "analyzed_dry_run");
    assert.equal(r.planned_setup_call.targetClientCode, "manualcode");
  });
});

describe("migrateAtjsToWebsdk: includeRunbook:false", () => {
  test("runbook_markdown is null", async () => {
    const r = await migrateAtjsToWebsdk({
      url: `${baseUrl}/atjs-2-clean.html`,
      propertyName: "x",
      domains: ["x.example.com"],
      includeRunbook: false,
    });
    assert.equal(r.runbook_markdown, null);
    assert.equal(r.analysis.atjs.present, true);
  });
});
