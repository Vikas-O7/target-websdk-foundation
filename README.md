# Target Web SDK Foundation

> **One MCP tool call: zero credentials → working Adobe Target Web SDK implementation.**
> Datastream, Tags property, Web SDK extension, data elements, page-load rule, dev library, embed code — built end-to-end and validated against the live Adobe Edge Network. Roughly 3 minutes.

[![npm version](https://img.shields.io/npm/v/target-websdk-foundation.svg)](https://www.npmjs.com/package/target-websdk-foundation)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/target-websdk-foundation.svg)](package.json)

> ⚠️ **Independent open-source tool. Not affiliated with Adobe.** Built and maintained by [Vikas-O7](https://github.com/Vikas-O7).

---

## What this is

An **MCP server** for Claude / Claude Code / Cursor / any MCP host. It drives Adobe's Reactor API and Edge Metadata API to bootstrap a complete Adobe Target Web SDK implementation in a single conversation. Hand it your Adobe credentials and a website domain; it produces a dev embed code you paste into your site's `<head>`.

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

## The 20 tools

| Group | Tools |
|---|---|
| **Datastreams (4)** | `list_datastreams`, `create_datastream`, `add_target_to_datastream`, `add_analytics_to_datastream` |
| **Property setup (8)** | `list_properties`, `create_tags_property`, `setup_property_infrastructure`, `install_websdk_extension`, `create_standard_data_elements`, `create_standard_rules`, `get_property_status`, `get_embed_code` |
| **Library (2)** | `create_dev_library`, `get_dev_library_status` |
| **Validation (5)** | `validate_datastream`, `validate_tags_property`, `test_edge_network`, `check_website_implementation`, `run_full_validation` |
| **Orchestration (1)** | `setup_target_websdk` (the one-shot wizard) |

Full reference: [docs/api-reference.md](docs/api-reference.md).

## How it works under the hood

- **Reactor API** (`https://reactor.adobe.io`) — Tags property, extensions, data elements, rules, library, build.
- **Edge Metadata API** (`https://edge.adobe.io/metadata/...`) — Datastream management.
- **Edge Network** (`https://edge.adobedc.net/ee/v2/interact`) — Live connection test, no auth headers (public endpoint).

The Edge Metadata API is **undocumented by Adobe**. This MCP discovered the request shape by inspecting what Adobe's own Data Collection UI sends. See [docs/architecture.md](docs/architecture.md) for the full reverse-engineering notes.

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
