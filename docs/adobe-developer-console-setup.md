# Adobe Developer Console + Admin Console Setup

This is the **most-read doc** for this project — the credential setup is the highest-friction step. If you hit a 401/403/404 from the MCP, the cause is almost always something in this checklist.

Total time: ~10 minutes for first-time setup.

---

## What you'll create

```
Adobe Developer Console project
├── OAuth Server-to-Server credential  (CLIENT_ID + CLIENT_SECRET)
└── API products
    ├── Adobe Experience Platform API  → datastream management
    └── Experience Platform Launch API → Tags property, extensions, rules, libraries

Adobe Admin Console
└── Product profile assignments  (the credential's technical account → product profiles)
    ├── Adobe Experience Platform → Data Collection admin profile
    └── Experience Platform Launch → Launch / Tags admin profile
```

---

## Step 1 — Create the Developer Console project

1. Go to **https://developer.adobe.com/console**
2. Click **"Create new project"** (top right)
3. Rename the project to something memorable, e.g. `target-websdk-automation`

## Step 2 — Add the OAuth Server-to-Server credential

1. In your project, click **"Add to Project"** → **"API"**
2. Choose **"OAuth Server-to-Server"** as the credential type. (Don't pick JWT — it's deprecated as of June 2025.)
3. Click **"Next"** through the API selection (we'll add APIs after the credential is created)
4. Adobe generates `CLIENT ID`, `CLIENT SECRET`, `TECHNICAL ACCOUNT ID`, and `ORGANIZATION ID`. **Copy these — you'll need them in `.env`.**

## Step 3 — Add the two required API products

While in the project, click **"Add to Project"** → **"API"** twice and add:

### a) Adobe Experience Platform API

- Search for "Adobe Experience Platform API"
- During product profile selection, choose the profile that has the **Data Collection admin** role for your AEP sandbox.
  - If you don't see a profile with that role, you'll need to ask your Adobe org admin to create one (see Step 4).
- Confirm.

### b) Experience Platform Launch API

- Search for "Experience Platform Launch API" (this is what Adobe internally calls Reactor / Tags)
- During product profile selection, choose the profile that has **Launch admin** / **Tags admin** for your company.
  - The profile name is usually `Launch - <yourcompany>` or `Tags - <yourcompany>`.
- Confirm.

> **Why two separate APIs?** The Datastream management API lives in AEP. Tags property management lives in Reactor. They're separate Adobe products historically, and this MCP needs both.

## Step 4 — Admin Console product profile assignment

This is the step everyone misses. Even after adding APIs in Developer Console, the credential's **technical account** must be a **member** of the matching product profile in **Admin Console**.

1. Go to **https://adminconsole.adobe.com**
2. **Products** → **Adobe Experience Platform**
3. Pick the product profile you assigned in Step 3a (e.g. *"Data Collection — `<your-org>`"*)
4. **Users / API credentials** tab → **Add user**
5. Search by the **Technical Account email** Adobe generated for your credential (looks like `<uuid>@techacct.adobe.com`)
6. Add them as a member.

Repeat for **Experience Platform Launch**:

1. Admin Console → **Products** → **Experience Platform Launch**
2. Pick the Launch admin profile (e.g. *"Launch - `<your-org>`"*)
3. Add the same technical account email as a member.

> **Symptom if you skip this step**: API calls return `403221 "Token not allowed in the current context"`. The error doesn't tell you WHICH product profile is missing — usually it's the Data Collection one (it's the most often-forgotten).

## Step 5 — Confirm sandbox name

The MCP defaults to sandbox `prod`. Confirm yours:

1. AEP UI (https://experience.adobe.com) → **Data Collection** → **Datastreams**
2. Look at the URL bar. The path contains `sname:<sandbox-name>`. E.g. `sname:prod`.
3. If your sandbox isn't `prod`, set `ADOBE_SANDBOX_NAME=<your-sandbox>` in `.env`.

## Step 6 — Fill in your `.env`

After `npm install -g target-websdk-foundation`, copy the example:

```bash
cp $(npm root -g)/target-websdk-foundation/.env.example .env
```

Fill in:

```bash
ADOBE_CLIENT_ID=<from step 2>
ADOBE_CLIENT_SECRET=<from step 2>
ADOBE_ORG_ID=<from step 2 — must end with @AdobeOrg>
ADOBE_SCOPES=openid,AdobeID,read_organizations,additional_info.projectedProductContext,additional_info.roles
ADOBE_SANDBOX_NAME=<from step 5; default "prod">
```

## Step 7 — Smoke test

Wire to your MCP host (see main [README.md](../README.md) §4), then run:

```text
list_properties
```

Expected: a list of all Tags properties in your org. If you get this back, **all credentials and product profile assignments are correct**.

Then:

```text
list_datastreams
```

Expected: a list of all datastreams in the sandbox. If this works, you're fully set up.

---

## Common failures and their causes

| Error | Likely cause | Fix |
|---|---|---|
| `IMS token exchange failed (400)` | Wrong CLIENT_ID or CLIENT_SECRET | Re-copy from Dev Console |
| `IMS token exchange failed (401)` | Credential expired or revoked | Generate a new client secret in Dev Console |
| `Reactor API 403 ... 403221 "Token not allowed in the current context"` | Missing Launch admin product profile membership | Step 4 (Launch part) |
| `Edge Metadata API 403 "Api key is invalid"` | This shouldn't happen — the MCP uses the right api-key. If you see it, the MCP version is broken; open an issue. | — |
| `Edge Metadata API 403 ... 403221` | Missing Data Collection product profile membership | Step 4 (AEP part) |
| `Platform API 404 "openresty" HTML` | AEP product not added to Dev Console project, OR wrong sandbox name | Step 3a + Step 5 |
| `Reactor returned no companies` | The Launch API was added but the org has no Reactor company set up | Contact Adobe support — the org needs Reactor provisioned at the tenant level |

---

## Security notes

- **Never commit `.env`.** It's gitignored by default.
- **Rotate credentials annually** (or per your org's policy). Dev Console makes it one click.
- **The bearer token is cached in memory** for ~24 hours by IMS. Restarting the MCP forces a new exchange.
- **The undocumented Edge Metadata API uses `x-api-key: Activation-DTM`** (Adobe's UI client identifier). This is a publicly known value, not a secret. It's required because Adobe's gateway allowlists known UI clients on that route.
