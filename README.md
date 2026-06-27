# Target Web SDK Foundation

> **One MCP tool call: zero credentials → working Adobe Target Web SDK implementation.**
> Datastream, Tags property, Web SDK extension, data elements, page-load rule, dev library, embed code — built end-to-end and validated against the live Adobe Edge Network. Roughly 3 minutes.

> 🆕 **v1.2**: Streamable HTTP transport. Deploy once to Vercel; anyone in your team adds the URL to Adobe CX Coworker → MCP Servers and is ready in 2 minutes. [Setup guide](docs/cx-coworker-setup.md).

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)
[![Status](https://img.shields.io/badge/status-pre--release-orange.svg)](https://github.com/Vikas-O7/target-websdk-foundation)
<!-- Uncomment after first npm publish:
[![npm version](https://img.shields.io/npm/v/target-websdk-foundation.svg)](https://www.npmjs.com/package/target-websdk-foundation)
-->


> ⚠️ **Independent open-source tool. Not affiliated with Adobe.** Built and maintained by Vikas Ohlan [Vikas-O7](https://github.com/Vikas-O7).

---

## What this is

An **MCP server** for Claude / Claude Code / Cursor / Adobe CX Coworker / any MCP host. It drives Adobe's Reactor API and Edge Metadata API to bootstrap a complete Adobe Target Web SDK implementation in a single conversation. Hand it your Adobe credentials and a website domain; it produces a dev embed code you paste into your site's `<head>`.

**Two deployment modes:**
- **stdio (local)**: `npm install -g target-websdk-foundation` → add to your local `~/.claude.json`. Single-tenant; credentials in env vars. Good for solo developers.
- **HTTP (hosted)**: Deploy to Vercel (or self-host) → add the URL to Adobe CX Coworker / Claude.ai MCP settings. Multi-tenant; credentials per-user via headers. Good for teams.

## What this is NOT

- **Not for at.js → Web SDK migration.** Different problem, future product.
- **Not for Target activity creation.** Use Adobe's [official Target MCP](https://experienceleague.adobe.com/en/docs/target/using/mcp/target-mcp) or the Target UI.
- **Not for visual verification.** Use Target Lens, AEP Debugger, or your browser.
- **Not for mobile properties.** Web only in v1.

## Quickstart (5 minutes)

### 1 — One-time Adobe setup

You need an Adobe Developer Console project with:
- OAuth Server-to-Server credential
- **Adobe Experience Platform API** product
- **Experience Platform Launch API** product

And in Adobe Admin Console, the credential's technical account assigned to:
- A Tags (Launch) admin product profile
- A Data Collection admin product profile

Step-by-step walkthrough with screenshots: [docs/adobe-developer-console-setup.md](docs/adobe-developer-console-setup.md).

### 2 — Install

```bash
npm install -g target-websdk-foundation
```

### 3 — Configure credentials

```bash
# Copy the example, fill in real values
cp $(npm root -g)/target-websdk-foundation/.env.example .env
# Edit .env — put your CLIENT_ID, CLIENT_SECRET, ORG_ID, sandbox name
```

### 4 — Wire to your MCP host

For Claude Code / Claude Desktop, add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "target-websdk-foundation": {
      "type": "stdio",
      "command": "node",
      "args": ["<global-npm-path>/target-websdk-foundation/build/index.js"]
    }
  }
}
```

Or use `npx`:

```json
{
  "mcpServers": {
    "target-websdk-foundation": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "target-websdk-foundation"]
    }
  }
}
```

Restart your MCP host fully.

### 5 — Run the wizard

In your MCP host, ask:

> *"Set up Adobe Target Web SDK for `luma.example.com`. Datastream name: `Luma Production`. Tags property name: `Luma - Target WebSDK`."*

The agent calls `setup_target_websdk` and runs the full 9-step flow:

1. Create datastream
2. Add Target service to datastream
3. *(optional)* Add Analytics service if A4T requested
4. Create Tags property
5. Create Akamai host + Dev/Staging/Production environments
6. Install AEP Web SDK extension wired to the datastream
7. Create 10 standard data elements (page context, identity map, XDM page view, Target profile attrs)
8. Create page-load Send Event rule with `renderDecisions: true`
9. Build dev library and return the embed code

Output: a working `<script src="https://assets.adobedtm.com/.../launch-...min.js" async></script>` ready to paste into your site's `<head>`.

### 6 — Verify it works

```text
test_edge_network(datastreamId: "<your-id>", waitForPropagationSeconds: 90)
```

Expect `target_responding: true`. Then paste the embed code into your site, reload, and check your browser's Network tab for a request to `edge.adobedc.net/ee/v2/interact`.

## The 22 tools

| Group | Tools |
|---|---|
| **Datastreams (4)** | `list_datastreams`, `create_datastream`, `add_target_to_datastream`, `add_analytics_to_datastream` |
| **Property setup (8)** | `list_properties`, `create_tags_property`, `setup_property_infrastructure`, `install_websdk_extension`, `create_standard_data_elements`, `create_standard_rules`, `get_property_status`, `get_embed_code` |
| **Library (2)** | `create_dev_library`, `get_dev_library_status` |
| **Validation (5)** | `validate_datastream`, `validate_tags_property`, `test_edge_network`, `check_website_implementation`, `run_full_validation` |
| **Orchestration (1)** | `setup_target_websdk` (the one-shot wizard) |
| **Discovery (1)** | `discover_site` *(v1.1)* — static fingerprint a URL: existing implementations, data layer flavor, framework, CMP vendor, page type. Returns a `recommended_setup` config block. |
| **Archetypes (1)** | `apply_archetype` *(v1.1)* — apply vertical-specific DEs + rules on top of a property. v1.1 ships `ecommerce_standard` (PDP, add-to-cart, checkout XDM events). |

Full reference: [docs/api-reference.md](docs/api-reference.md).

## How it works under the hood

- **Reactor API** (`https://reactor.adobe.io`) — Tags property, extensions, data elements, rules, library, build.
- **Edge Metadata API** (`https://edge.adobe.io/metadata/...`) — Datastream management.
- **Edge Network** (`https://edge.adobedc.net/ee/v2/interact`) — Live connection test, no auth headers (public endpoint).

The Edge Metadata API is **undocumented by Adobe**. This MCP discovered the request shape by inspecting what Adobe's own Data Collection UI sends. See [docs/architecture.md](docs/architecture.md) for the full reverse-engineering notes.

## Production-readiness checklist

This MCP gets you to a **working baseline** in one tool call. To take that baseline to a senior-consultant-grade production deployment, you'll likely need to harden a few items the MCP doesn't decide for you. Treat this as a pre-flight checklist before pasting the embed code into a high-traffic page:

| ✓ | Item | What & why | How to handle |
|---|---|---|---|
| ☐ | **Scope prehiding to specific containers** | Default hides the whole `<body>` while Target loads — users see a blank page during Edge response time. The #1 cited reason marketing teams disable Target. | Pass `flickerSelectors: ["#hero", ".product-card", ".checkout-cta"]` to `setup_target_websdk`. Scopes prehiding to just those containers. |
| ☐ | **Configure consent for EU/UK** | Default `consentMode: "in"` fires Target calls immediately. For GDPR you need `pending` + CMP-wired consent grant. | Pass `consentMode: "pending"`. Then wire your CMP (OneTrust / Cookiebot / Adobe Consent / IAB TCFv2) to dispatch a consent-granted event the Tags property listens to. v1.2 will auto-generate the consent rule per CMP vendor. |
| ☐ | **Add SPA view-change handler** | If your site is a SPA (React/Vue/Angular/Next.js), Target only fires on hard-load by default — no personalization on client-side route changes. | Pass `includeSpaRule: true` to `create_standard_rules` (or use a v1.1 `apply_archetype` that bundles this). |
| ☐ | **Add commerce events for ecommerce sites** | Standard Target recommendations algorithms need `commerce.productViews`, `commerce.productListAdds`, `commerce.checkouts`, `commerce.purchases` events to train. The MCP only adds `commerce.purchases` via `includeOrderRule`. | v1.2 ships an `apply_archetype: "ecommerce_standard"` tool that turns on the full commerce event suite. For v1.1, add the additional rules manually via `create_standard_rules` extensions. |
| ☐ | **Cross-device identity via hashed email** | For B2C with authenticated users, Target needs a hashed email (SHA-256) in identityMap to stitch experiences across devices. The MCP currently sets only `mbox3rdPartyId`. | Create a custom-code DE that SHA-256s the email, then add it to the Identity Map's Email namespace. v1.2 candidate. |
| ☐ | **Verify data layer paths match your site** | Default DE paths assume CEDDL (`digitalData.*`). Modern AEM / EDS sites use ACDL (`adobeDataLayer`); GTM-based sites use `dataLayer`. | Override `pageNamePath` and `crmIdPath` to match your actual data layer. The `discover_site` tool (v1.1) will auto-detect this. |
| ☐ | **Set a Target property token for workspace isolation** | Default omits propertyToken — all activities go to the default workspace. Production tenants with multiple consultants per org need this for scoping. | Pass `targetPropertyToken: "<at_property-uuid>"` to `setup_target_websdk`. Find the UUID in Target UI → Administration → Properties. |
| ☐ | **Tighten the alloy `context` array** | Default sends `["web", "device", "environment", "placeContext"]` on every event. Some sites legally cannot collect placeContext (geo) or device fingerprinting. | Override the Web SDK extension settings in Tags UI after install. |
| ☐ | **Promote dev → staging → production** | The MCP only builds the dev library. Staging and production builds require explicit approval steps. | Use the Tags UI publishing workflow. |
| ☐ | **Pre-connect DNS for Edge** | Adds `<link rel="preconnect" href="https://edge.adobedc.net">` to your page `<head>` — shaves ~50ms off first Edge call. | Manual `<link>` tag in your site template. |

The MCP runs `validate_tags_property` against your finished property and surfaces warnings for several of these items so you can spot what's been hardened and what hasn't.

## Known caveats

- **Edge propagation delay.** Newly-created datastreams take 30–60 seconds for the Edge Network to start routing. The `setup_target_websdk` orchestrator handles this; the standalone `test_edge_network` tool accepts `waitForPropagationSeconds` (recommend 90).
- **Undocumented APIs may change.** If Adobe alters the Edge Metadata endpoint, this MCP may break without warning. Issues welcome — see "If something breaks" below.
- **One-property-per-domain-set limit.** Reactor will error on duplicate property names by default; pass `returnIfExists: true` (the default) to re-use an existing one.

## Troubleshooting

Common issues and resolutions: [docs/troubleshooting.md](docs/troubleshooting.md).

## If something breaks

1. **Capture the failing tool call + error** (the MCP returns the full Adobe API response).
2. **Open an issue** with the captured payload (redact your bearer token).
3. If the Edge Metadata API shape has changed, include a fresh `cURL` capture from your AEP UI Network tab.

## Contributing

PRs welcome. Please:
- Open an issue first for scope changes
- Run `npm run build` clean before submitting
- Don't hardcode tenant-specific values in tests

## License

Apache License 2.0 — see [LICENSE](LICENSE).

---

*Maintained by [Vikas-O7](https://github.com/Vikas-O7). Independent open-source tool. Not affiliated with Adobe.*
