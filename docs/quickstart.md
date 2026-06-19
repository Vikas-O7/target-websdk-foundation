# Quickstart

Zero-to-working Web SDK in 5 minutes, assuming credentials are already in place.

## 0 — Prerequisites

- Node 20 or later
- Adobe Developer Console credential set up — see [adobe-developer-console-setup.md](adobe-developer-console-setup.md)
- An MCP host (Claude Desktop, Claude Code, Cursor, etc.)

## 1 — Install

```bash
npm install -g target-websdk-foundation
```

## 2 — Configure

```bash
cp $(npm root -g)/target-websdk-foundation/.env.example .env
```

Edit `.env`:

```bash
ADOBE_CLIENT_ID=...
ADOBE_CLIENT_SECRET=...
ADOBE_ORG_ID=...@AdobeOrg
ADOBE_SCOPES=openid,AdobeID,read_organizations,additional_info.projectedProductContext,additional_info.roles
ADOBE_SANDBOX_NAME=prod
```

## 3 — Wire to your MCP host

Add to `~/.claude.json` (Claude Code / Claude Desktop):

```json
{
  "mcpServers": {
    "target-websdk-foundation": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to>/target-websdk-foundation/build/index.js"]
    }
  }
}
```

Find `<path-to>` via:

```bash
echo "$(npm root -g)/target-websdk-foundation"
```

Restart Claude **fully** — the MCP subprocess survives in-app restarts. On Windows PowerShell:

```powershell
Get-Process claude -ErrorAction SilentlyContinue | Stop-Process -Force
```

Then relaunch.

## 4 — Smoke test

In Claude, ask:

> "Run `list_properties` against my Tags org."

You should see your existing Tags properties. If you get an empty list or an error, see [troubleshooting.md](troubleshooting.md).

## 5 — Run the one-shot wizard

> "Set up Adobe Target Web SDK for `mysite.example.com`. Datastream name: `Mysite Production`. Tags property name: `Mysite - Target Web SDK`. Wait up to 90 seconds for Edge propagation after setup."

The agent calls `setup_target_websdk` with those params. End state: a `<script>` embed code ready to deploy.

## 6 — Deploy + verify

Paste the embed code into your site's `<head>`. In a browser, reload the page and check Network tab for a request to `edge.adobedc.net/ee/v2/interact`.

Then back in Claude:

> "Run `test_edge_network` against my datastream and `check_website_implementation` against `https://mysite.example.com`."

Expected: `target_responding: true` (datastream healthy) and `tags_embed_present: true` (script deployed correctly).

## What to do next

- **Create Target activities** in the Adobe Target UI (or via Adobe's official Target MCP). Activities targeting `mysite.example.com` URLs will now render automatically because the page-load rule has `renderDecisions: true`.
- **Promote to staging / production environment** via the Tags UI when ready. The dev embed is for testing only — don't deploy it to a high-traffic page.
- **Iterate.** Re-run `create_dev_library` after any property changes to rebuild.
