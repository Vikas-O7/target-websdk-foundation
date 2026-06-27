# Adobe CX Coworker setup

This MCP can be added to Adobe CX Coworker as a hosted MCP server. Once deployed to Vercel (or any HTTPS endpoint), any Adobe employee or customer with CX Coworker access can connect and use it with their own Adobe credentials.

This guide covers:
1. One-time deployment to Vercel (project owner)
2. Per-user setup in CX Coworker (end users)

---

## Part 1 — Deploy to Vercel (one-time)

Skip this if someone has already deployed and you're just connecting.

### Prerequisites
- A Vercel account (free tier is fine — https://vercel.com/signup)
- The repo cloned locally OR forked on GitHub

### Option A — One-click deploy (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FVikas-O7%2Ftarget-websdk-foundation&env=MCP_TRANSPORT&envDescription=Set%20to%20%22http%22%20to%20enable%20HTTP%20transport%20mode&project-name=target-websdk-foundation&repository-name=target-websdk-foundation)

1. Click the button above
2. Authorize Vercel to access your GitHub
3. Set the env var `MCP_TRANSPORT` to `http`
4. **Do NOT** set Adobe credentials as Vercel env vars — they're per-tenant and come from headers
5. Click Deploy

Vercel gives you a URL like `https://target-websdk-foundation-yourname.vercel.app`. The MCP endpoint is `<that-URL>/mcp`.

### Option B — CLI deploy

```bash
git clone https://github.com/Vikas-O7/target-websdk-foundation.git
cd target-websdk-foundation
npm ci
npm run build

# Install Vercel CLI if needed
npm i -g vercel

# Deploy
vercel --prod
```

When Vercel asks: set `MCP_TRANSPORT=http` env var. Skip every other env var (credentials are per-request).

### Verify the deploy

```bash
curl https://<your-deployment>.vercel.app/health
```

Expected output:
```json
{
  "name": "target-websdk-foundation",
  "version": "1.2.0",
  "transport": "streamable-http",
  "tools_count": 22,
  "docs": "https://github.com/Vikas-O7/target-websdk-foundation",
  "required_headers": [
    "x-adobe-client-id",
    "x-adobe-client-secret",
    "x-adobe-org-id",
    "x-adobe-scopes",
    "x-adobe-sandbox-name"
  ]
}
```

If that works, share the `<your-deployment>.vercel.app/mcp` URL with your team. They can connect via the steps below.

---

## Part 2 — Connect from CX Coworker (per-user)

Each user adds the MCP server with their own Adobe credentials.

### Prerequisites

Before connecting, the user needs an Adobe Developer Console OAuth Server-to-Server credential with the right APIs + product profiles. See [adobe-developer-console-setup.md](adobe-developer-console-setup.md) — this is the same prerequisite as the stdio install.

### Add the MCP server

1. Open **CX Coworker**
2. Click **MCP Servers** in the left nav
3. Click **+ Add MCP Server** in the top right
4. Fill in:

   | Field | Value |
   |---|---|
   | **Server Name** | `target-websdk-foundation` |
   | **Source URL** | `https://<your-deployment>.vercel.app/mcp` |
   | **Connection Type** | **HTTP** |
   | **Tool Timeout (seconds)** | **120** *(some Adobe operations like library builds take 30+ s; default 60 is sometimes tight)* |
   | **Authentication** | **None** *(custom auth via headers below)* |

5. Click **+ Add header** five times and add:

   | Header Name | Value |
   |---|---|
   | `X-Adobe-Client-Id` | Your client ID from Adobe Developer Console |
   | `X-Adobe-Client-Secret` | Your client secret |
   | `X-Adobe-Org-Id` | Your Adobe Org ID (`XXXXXXXXX@AdobeOrg`) |
   | `X-Adobe-Scopes` | `openid,AdobeID,read_organizations,additional_info.projectedProductContext,additional_info.roles` |
   | `X-Adobe-Sandbox-Name` | `prod` *(or your AEP sandbox name)* |

6. Click **Add Server**

CX Coworker will probe the server, list the 22 tools, and show a green "Connected" badge if everything's wired correctly.

### Smoke test

In a CX Coworker chat:

> *"List all my Adobe Target datastreams."*

Coworker should pick `mcp__target-websdk-foundation__list_datastreams` and return your datastreams within ~5 seconds.

If you get `missing_or_invalid_credentials` errors → recheck the headers in step 5.
If you get `403` errors → see [troubleshooting.md](troubleshooting.md) (most likely Admin Console product profile issue).

---

## Security notes

- **Your credentials never leave your Coworker workspace.** CX Coworker stores the headers on its end and adds them to each request to the MCP server. The MCP server itself is stateless — it doesn't persist credentials.
- **The Vercel-hosted server is multi-tenant.** Multiple users can connect to the same deployment using their own credentials. The IMS token cache and Reactor company-ID cache are keyed by client_id / org_id so no cross-tenant leakage is possible.
- **The MCP server makes outbound calls to:**
  - `ims-na1.adobelogin.com` (IMS token exchange)
  - `reactor.adobe.io` (Tags property API)
  - `edge.adobe.io` (Datastream API — undocumented endpoint, same one the AEP UI uses)
  - `edge.adobedc.net` (live Edge Network test)
- **The MCP server does NOT make calls to:** any database, any analytics tool, any third-party service. No telemetry.

## Self-hosting (alternative to Vercel)

The Streamable HTTP server is a standard Node.js HTTP app. You can host it on:

- **Cloudflare Workers** — needs minor adaptation (use `WebStandardStreamableHTTPServerTransport` instead of the Node wrapper)
- **Railway / Render / Fly.io** — works as-is with the `start:http` script
- **Adobe internal infrastructure** — if you have a path to `cx-enterprise.adobe.io` hosting, that gives you the "CX Enterprise" badge in the Coworker UI
- **Your own VPS** — `npm run start:http` runs a long-lived process on port 3000

For all options, set `MCP_TRANSPORT=http` and DO NOT set Adobe credentials in the server's environment — they're per-request via headers.

## Limits

- **Cold-start latency**: Vercel free tier has ~500ms cold starts when a function hasn't been invoked recently. After the first tool call in a session, subsequent calls are warm and fast.
- **Function timeout**: Set to 300 seconds in `vercel.json` (Vercel free tier max). Most tools complete in 1-5 seconds; library builds in 30-60 seconds.
- **Concurrency**: Free Vercel tier supports unlimited concurrent invocations but only up to 100 GB-hours/month of compute. For a single user, that's effectively unlimited; for ~50 active users, you might hit the cap and need the Pro tier ($20/month).
