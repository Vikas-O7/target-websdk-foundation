/**
 * Tests for src/api/compat-shim.ts.
 *
 * Covers: shim generation correctness, generated JS parseability via
 * vm.Script, runtime execution in a sandboxed Window mock, getOffer and
 * triggerView semantics.
 */
import { test, describe, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import vm from "node:vm";

import { analyzeAtjsImplementation } from "../src/api/atjs-analysis.js";
import { generateAtjsCompatShim } from "../src/api/compat-shim.js";

const SAMPLE = `<!DOCTYPE html><html><head>
  <script>
    window.targetGlobalSettings = {
      clientCode: 'demo-client',
      timeout: 5000,
      defaultContentHiddenStyle: 'visibility: hidden'
    };
  </script>
  <script src="//assets.adobedtm.com/launch/EN1234/at.js-2.11.2.min.js"></script>
</head><body>
  <div mbox="hero">x</div>
  <div data-mbox="featured">x</div>
  <script>
    adobe.target.getOffer({mbox: 'pdp-recommendations'});
    mboxCreate('cart-upsell');
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

describe("generateAtjsCompatShim: generation correctness", () => {
  test("returns js + instructions + metadata", async () => {
    const report = await analyzeAtjsImplementation({
      url: `${baseUrl}/`,
      knownMboxes: ["network-captured-extra"],
    });
    const shim = generateAtjsCompatShim(report);
    assert.equal(typeof shim.js, "string");
    assert.ok(shim.js.length > 1000);
    assert.equal(typeof shim.instructions, "string");
    assert.ok(shim.instructions.length > 500);
    assert.equal(shim.metadata.client_code, "demo-client");
    assert.ok(shim.metadata.mbox_count >= 4);
    assert.equal(shim.metadata.alloy_instance, "alloy");
    assert.ok(shim.metadata.estimated_size_bytes > 1000);
  });

  test("js is an IIFE", async () => {
    const report = await analyzeAtjsImplementation({ url: `${baseUrl}/` });
    const shim = generateAtjsCompatShim(report);
    assert.match(shim.js, /\(function \(\) \{[\s\S]*\}\)\(\);?\s*$/);
  });

  test("js interpolates client code + mbox catalog", async () => {
    const report = await analyzeAtjsImplementation({
      url: `${baseUrl}/`,
      knownMboxes: ["network-captured-extra"],
    });
    const shim = generateAtjsCompatShim(report);
    assert.ok(shim.js.includes("demo-client"));
    assert.ok(shim.js.includes("pdp-recommendations"));
    assert.ok(shim.js.includes("hero"));
  });

  test("js binds all 7 adobe.target.* methods + 1.x stubs", async () => {
    const report = await analyzeAtjsImplementation({ url: `${baseUrl}/` });
    const shim = generateAtjsCompatShim(report);
    for (const m of [
      "window.adobe.target.getOffer",
      "window.adobe.target.applyOffer",
      "window.adobe.target.getOffers",
      "window.adobe.target.applyOffers",
      "window.adobe.target.trackEvent",
      "window.adobe.target.triggerView",
      "window.adobe.target.init",
    ]) {
      assert.ok(shim.js.includes(m), `missing binding: ${m}`);
    }
    assert.ok(shim.js.includes("mboxCreate"));
    assert.ok(shim.js.includes("mboxDefine"));
    assert.ok(shim.js.includes("mboxUpdate"));
  });
});

describe("generateAtjsCompatShim: parseability + runtime behavior", () => {
  test("generated JS parses via vm.Script", async () => {
    const report = await analyzeAtjsImplementation({ url: `${baseUrl}/` });
    const shim = generateAtjsCompatShim(report);
    assert.doesNotThrow(() => new vm.Script(shim.js));
  });

  test("shim wires adobe.target.* on a mock window", async () => {
    const report = await analyzeAtjsImplementation({ url: `${baseUrl}/` });
    const shim = generateAtjsCompatShim(report);
    const calls: Array<{ cmd: string; payload: any }> = [];
    const context: any = vm.createContext({
      alloy: (cmd: string, payload: any) => {
        calls.push({ cmd, payload });
        return Promise.resolve({ propositions: [] });
      },
      document: { querySelector: () => null, addEventListener: () => {}, dispatchEvent: () => {} },
      console: { log: () => {}, warn: () => {}, error: () => {} },
      CustomEvent: function (n: string, o: any) { return { type: n, detail: o?.detail }; },
      Promise,
      location: { search: "?target_shim_debug=1" },
      adobe: undefined,
    });
    context.window = context;
    vm.runInContext(shim.js, context);

    assert.equal(typeof context.adobe.target.getOffer, "function");
    assert.equal(typeof context.adobe.target.applyOffer, "function");
    assert.equal(typeof context.adobe.target.getOffers, "function");
    assert.equal(typeof context.adobe.target.trackEvent, "function");
    assert.equal(typeof context.adobe.target.triggerView, "function");
    assert.equal(typeof context.adobe.target.init, "function");
    assert.equal(typeof context.mboxCreate, "function");
  });

  test("getOffer dispatches to alloy with decisionScopes", async () => {
    const report = await analyzeAtjsImplementation({ url: `${baseUrl}/` });
    const shim = generateAtjsCompatShim(report);
    const calls: Array<{ cmd: string; payload: any }> = [];
    const context: any = vm.createContext({
      alloy: (cmd: string, payload: any) => {
        calls.push({ cmd, payload });
        return Promise.resolve({
          propositions: payload.decisionScopes?.map((s: string) => ({
            scope: s,
            items: [{
              schema: "https://ns.adobe.com/personalization/html-content-item",
              data: { content: `<b>offer for ${s}</b>`, selector: `#${s}` },
            }],
          })) ?? [],
        });
      },
      document: { querySelector: () => null, addEventListener: () => {}, dispatchEvent: () => {} },
      console: { log: () => {}, warn: () => {}, error: () => {} },
      CustomEvent: function (n: string, o: any) { return { type: n, detail: o?.detail }; },
      Promise,
      location: { search: "" },
      adobe: undefined,
    });
    context.window = context;
    vm.runInContext(shim.js, context);

    let receivedOffers: any = null;
    await new Promise<void>((resolve) => {
      context.adobe.target.getOffer({
        mbox: "pdp-recommendations",
        success: (offers: any) => { receivedOffers = offers; resolve(); },
        error: () => resolve(),
      });
    });

    assert.ok(calls.length >= 1);
    const lastCall = calls[calls.length - 1];
    assert.equal(lastCall.cmd, "sendEvent");
    // JSON-roundtrip to dodge cross-realm prototype mismatch on arrays
    // returned from vm.runInContext (deepStrictEqual rejects them).
    assert.equal(JSON.stringify(lastCall.payload.decisionScopes), '["pdp-recommendations"]');
    assert.ok(Array.isArray(receivedOffers));
    assert.equal(receivedOffers.length, 1);
    assert.equal(receivedOffers[0].type, "html");
    assert.ok(receivedOffers[0].content.includes("offer for pdp-recommendations"));
  });

  test("triggerView dispatches with viewName in xdm", async () => {
    const report = await analyzeAtjsImplementation({ url: `${baseUrl}/` });
    const shim = generateAtjsCompatShim(report);
    const calls: Array<{ cmd: string; payload: any }> = [];
    const context: any = vm.createContext({
      alloy: (cmd: string, payload: any) => {
        calls.push({ cmd, payload });
        return Promise.resolve({});
      },
      document: { querySelector: () => null, addEventListener: () => {}, dispatchEvent: () => {} },
      console: { log: () => {}, warn: () => {}, error: () => {} },
      CustomEvent: function (n: string, o: any) { return { type: n, detail: o?.detail }; },
      Promise,
      location: { search: "" },
      adobe: undefined,
    });
    context.window = context;
    vm.runInContext(shim.js, context);

    context.adobe.target.triggerView("checkout-step-2");
    await new Promise((r) => setImmediate(r));

    assert.ok(calls.length >= 1);
    const lastCall = calls[calls.length - 1];
    assert.equal(lastCall.payload.xdm.web.webPageDetails.viewName, "checkout-step-2");
  });
});
