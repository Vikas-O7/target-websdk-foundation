# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.1] - 2026-06-29

Hotfix closing out the long-standing v1.0 "duplicate Development environment" known issue. No new tools or features. **Tool count unchanged: 23.**

### Fixed

- **Deterministic environment selection on re-run.** When `setup_target_websdk` re-runs against a property that has duplicate environments for a single stage (a v1.0 artifact — see context below), the orchestrator now picks the **oldest** environment per stage (sorted ascending by `created_at`) instead of relying on Reactor's undefined list order. Same env ID is returned across every re-run; libraries pinned to the older env aren't silently swapped to a duplicate.
- **Duplicate-env warn log.** When `setupPropertyInfrastructure` detects more than one env per stage, it emits a stderr `warn` line listing the duplicate IDs and pointing the user at the manual cleanup path (Tags UI or `DELETE /environments/{id}`). Surfaces the polluted state instead of silently masking it.

### Context — why this didn't need a behavior change

Live re-validation against `agsinternal` on 2026-06-29 confirmed v1.1+ orchestrator code is already idempotent: re-running `setup_target_websdk` against a property with 3 canonical envs returns the same env IDs and creates nothing new. The duplicate state on the older `MCP-Validation-Luma-2026-06-22` test property was traced to commits prior to `c976d72` (`fix: make setup_target_websdk orchestrator fully idempotent`, 2026-06-22) where the env POST had no pre-flight check. The bug closed itself the day v1.1 shipped; the `troubleshooting.md` "tracked for v1.1.1" note was stale documentation.

This release upgrades the dedup from "last-write-wins on an undefined-order list" to "explicit oldest-first," which is the deterministic version of the behavior that was already happening accidentally. Pre-existing duplicate envs on legacy properties are NOT auto-deleted (deletion is risky when libraries may be attached) — the warn log gives the user the info needed to clean them up manually.

### Documentation

- `docs/troubleshooting.md` "Known issues" section rewritten: the duplicate-dev-env bug is now documented as **fixed in v1.1.0**, with manual cleanup steps for any legacy property still carrying duplicate envs.
- `HANDOVER.md` known-issues section updated accordingly.

---

## [1.3.0] - 2026-06-28

The "consultant-grade page-load rule" release. Closes 7 of the 9 gaps identified in the v1.2 consultant audit. The two PDP-specific items (Library Loaded + Guided Events on the ecommerce archetype's PDP rule, plus configurable PDP path) are deferred to v1.4. **Tool count: 22 → 23.**

### Added

- **`sync_property_catalog` tool** — upgrade a property created under an older MCP version (v1.0/v1.1/v1.2) to the current standard catalog. Idempotently adds the DEs and rules that are missing; touches nothing already present. Use this when a property is missing v1.1's `Page - Type` or `Target - Send Event Data` DEs because it was set up before those existed in the catalog.
- **Page-load rule conditions menu** — new `pageLoadConditions` orchestrator param accepts an array of typed condition specs. Compiled to the right Reactor descriptor + settings:
  - `url-matches` → `core::conditions::path-and-querystring`
  - `path-only` → `core::conditions::path`
  - `cookie-equals` → `core::conditions::cookie`
  - `domain-matches` → `core::conditions::domain`
  - `subdomain-matches` → `core::conditions::subdomain`
  - `data-element-equals` → `core::conditions::value-comparison`
  - `raw` → escape hatch for any Reactor descriptor + settings
  Each condition supports `negate`. All conditions are AND-ed on the rule. Confirmed live against core 3.4.4.
- **`dataElementSelection` selection map** on `setup_target_websdk` and `sync_property_catalog`. Categorical defaults (`pageContext`, `identity`, `targetProfile`, `xdm`, `environment`, `orderTracking`) plus per-name `overrides`. Lets consultants drop DE families their site doesn't need without writing rule code.
- **`includePageLoadRule: boolean`** orchestrator param (default `true`) — skip page-load rule creation entirely for sites managing the rule manually.

### Changed — Consultant-grade page-load rule

- **Trigger event: DOM Ready → Library Loaded (Page Top)**. Fires before DOM Ready so Target has a head start on personalization before pixels render. Significantly less flicker on personalized content.
- **Send Event: manual config → Guided Events mode**. The page-load rule now uses Adobe's "Use Guided Events" with the `personalizationRequest` mode — fetches Target decisions without double-counting a page view in Analytics. Wire `xdm` and `data` via DE references as before; Adobe derives the `type` field internally.
- **Data field wired to the `Target - Send Event Data` wrapper DE** by default. v1.1 created this DE but didn't reference it; v1.3 ensures the page-load rule's Send Event action actually passes profile attributes + mbox3rdPartyId to Target. Closes the "profile-based audience targeting silently fails" footgun.

### Fixed

- **Dot-notation in `Target - Profile Attributes` DE source code** — replaced bracket notation (`attrs["loyaltyStatus"]`) with dot notation (`attrs.loyaltyStatus`), eliminating the Reactor UI linter warnings. No functional change.

### Not in this release (deferred to v1.4)

- PDP rule (ecommerce archetype) Library Loaded + Guided Events conversion (item 4 in the audit) — defer
- Configurable PDP path with `discover_site` integration (item 5) — defer

These two are scoped together for v1.4 since they're PDP-specific.

### Migration notes

- **Backward compatible.** v1.2 callers using `includeOrderDes`, manual `flickerStyle`, etc. keep working unchanged. The new params have sensible defaults that match consultant best practice.
- **Re-running `setup_target_websdk` on a v1.2 property won't update the existing page-load rule** (idempotency-by-name correctly skips it). To get v1.3's Library Loaded + Guided Events rule on a v1.2 property: delete the old rule in the Reactor UI, then run `sync_property_catalog`. Or use `setup_target_websdk` on a fresh property name.

---

## [1.2.0] - 2026-06-27

### Added — Hosted HTTP deployment

This release adds **Streamable HTTP transport** so the same MCP can run as a hosted multi-tenant service. The original stdio mode is unchanged — every existing local install keeps working.

- **`src/index-http.ts`** — HTTP entry point. Boots a Streamable HTTP transport (per the November 2025 MCP spec). Each request is authenticated by custom headers and runs in an isolated AsyncLocalStorage context so multiple tenants can share one Node process without credential leakage.
- **`api/mcp.ts`** — Vercel serverless function wrapper.
- **`vercel.json`** — Vercel deployment config. Routes `/`, `/health`, `/mcp` to the same function with a 300-second timeout.
- **`src/request-context.ts`** — AsyncLocalStorage-backed per-request configuration. Includes `configFromHeaders()` for extracting tenant credentials from custom HTTP headers (`X-Adobe-Client-Id`, `X-Adobe-Client-Secret`, `X-Adobe-Org-Id`, `X-Adobe-Scopes`, `X-Adobe-Sandbox-Name`).
- **`docs/cx-coworker-setup.md`** — step-by-step guide for deploying to Vercel and connecting from Adobe CX Coworker.
- **`bin: target-websdk-foundation-http`** — new entry point for `npx target-websdk-foundation-http` to run a local HTTP dev server on port 3000.
- **`npm scripts`**: `dev:http`, `start:http`.

### Changed — Multi-tenant safety

The IMS token cache (`src/auth/adobe-ims.ts`) and Reactor company-ID cache (`src/api/reactor-client.ts`) were previously module-global singletons. In HTTP mode many tenants share one Node process, so these caches are now **keyed by `client_id` / `org_id`** to prevent cross-tenant leakage. Stdio mode behavior is unchanged (single tenant = single cache entry, same effective behavior as before).

`src/config.ts` is now context-aware: in HTTP mode, every `config.X` access reads from the current request's AsyncLocalStorage context; in stdio mode, the boot-time env parse continues to work unchanged. Existing API client code is unmodified (no parameter threading required).

### Documentation

- README updated with the dual-mode story (stdio vs HTTP) and a 1-click Deploy to Vercel button.
- CX Coworker setup guide covers prerequisites, one-time Vercel deploy, per-user connection flow, security notes, and self-hosting alternatives (Cloudflare Workers, Railway, Adobe internal infra).

### What's NOT in this release

The "principal-consultant grade" implementation improvements (Library Loaded event swap, Guided Events configuration, selectable DEs/rules, page-load rule conditions menu, fixing the linter warnings in custom-code DEs, ensuring `Target - Send Event Data` DE is created on legacy v1.0 properties) are scoped for **v1.3.0**. They're additive on top of the v1.2 transport work.

---

## [1.1.0] - 2026-06-22

### Added

- **`discover_site`** tool — static-fetch fingerprint of any website URL. Detects existing Tags/alloy/at.js/DTM/GTM implementations, data layer flavor (CEDDL / ACDL / GTM / Tealium / none), framework signals (Next / React / Vue / Angular / Svelte / Nuxt / Remix / Gatsby / vanilla), CMP vendor (OneTrust / Cookiebot / Adobe Consent / Iubenda / TrustArc / Didomi / Usercentrics / Quantcast / IAB TCF / none), and page-type heuristic. Returns a `recommended_setup` block ready to thread into `setup_target_websdk`. Static fetch only — no JS execution; SPA-aware discovery via Chrome MCP integration deferred to v1.2.
- **`apply_archetype`** tool — opinionated, vertical-specific composition. v1.1 ships only `ecommerce_standard`, which adds Product SKU/Name/Category DEs, Cart Item Count DE, XDM payloads for productViews/addToCart/checkouts, and 3 rules (PDP product-view on `/product/*` paths, Add to Cart on `ecommerce:addToCart` custom event, Checkout Start on `/checkout`). b2b_lead_gen / media_publisher / saas_funnel archetypes deferred to v1.2.
- **`Page - Type` data element** in the standard catalog — URL + DOM heuristic returning the most-targeted-against attribute in real Target audiences.
- **`Target - Send Event Data` wrapper data element** — returns the `{__adobe: {target: {profile, mbox3rdPartyId}}}` payload that Reactor requires as a `%DE name%` string reference. Without this, profile-based audience targeting silently fails to receive profile attributes.
- **`flickerSelectors: string[]`** orchestrator param — preferred prehiding scope. Composes a CSS rule scoped to specific containers rather than hiding the whole `<body>`.
- **`consentMode: "in" | "pending"`** orchestrator param — sets Web SDK `defaultConsent`. Use `"pending"` for EU/UK GDPR-compliant setups and wire your CMP to dispatch the consent grant.
- **4 new validate-time warns** in `validate_tags_property` — flags prehiding scope, consent mode, missing `Page - Type` DE, and missing `Target - Send Event Data` DE.
- **"Production-readiness checklist"** section in README — explicit list of items the MCP does NOT decide for you, with workarounds.

### Changed

- **`setup_target_websdk` orchestrator** is now fully idempotent across re-runs: detects existing datastreams by name, reuses existing hosts and per-stage environments, picks up existing Web SDK extension, dedupes DEs and rules by name, and reuses existing dev libraries (rebuilding rather than 409'ing on "environment already in use").
- **`createDevLibrary`** now reuses an existing library tied to the target environment, PATCHing the resource relationship to replace contents rather than POST-appending (idempotent rebuild).
- **`Send Event` rule action** now references `Target - Send Event Data` for its `data` field, so profile params and mbox3rdPartyId actually reach Target.

### Fixed

Bugs surfaced during live re-validation against the live Adobe Reactor API:

- **Field-name drift**: `resolveExtensionIds`, `installWebSdkExtension`, `getCoreExtensionId`, and the validator all checked `attributes.extension_package_name`, which is `undefined` on extension instances. Reactor populates the field as `attributes.name`. All call sites now check both fields for safety across API versions.
- **Stale validator check**: removed the `Target.settings.clientCode` critical-fail check. The modern Datastream API has no `clientCode` field; Target tenant is org-level.
- **Revision filter missing**: `resolveCoreAndAlloy` (used by archetypes) didn't filter to `revision_number=0`, allowing `find()` to return a stale revision whose pinned package version didn't expose required descriptors. Now filters to HEAD revisions.
- **Wrong descriptor name**: `core::conditions::path-and-query` does not exist on the current core extension package. The correct descriptor is `core::conditions::path-and-querystring` (with "string"). Affected the order-confirmation rule (latent until `includeOrderRule: true`) and the ecommerce archetype's PDP + checkout rules.
- **Wrong field name on custom-event descriptor**: the `core::events::custom-event` schema uses `type` (the event name), not `eventType`. Affected the ecommerce archetype's Add to Cart rule.

### Known issues

- **Duplicate development environment** on re-run of `setup_target_websdk` against an existing property. Cosmetic; tracked for v1.1.1 patch. See [docs/troubleshooting.md](docs/troubleshooting.md#v110--duplicate-development-environment-on-re-run-of-setup_target_websdk).

### Tooling

- Tool count: 20 → **22** across 5 → **7** tool groups.
- Banner reads: `Target Web SDK Foundation v1.1.0 · 22 tools registered across 7 tool groups`.

---

## [1.0.0] - 2026-06-13

### Added

- Initial release: 20 MCP tools that bootstrap a complete Adobe Target Web SDK implementation end-to-end — datastream, Tags property, Web SDK extension, data elements, page-load rule, dev library, embed code.
- Validated against the live Adobe Edge Network during development.
- Targets Adobe's Reactor API (`https://reactor.adobe.io`) and the undocumented Edge Metadata API (`https://edge.adobe.io/metadata/...`) used by Adobe's own Data Collection UI.
- Comprehensive Adobe Developer Console + Admin Console setup guide.
- 12 schema corrections vs. internal-spec assumptions, captured during initial development:
  - Web SDK extension package name `adobe-alloy` (not `com.adobe.alloy`)
  - Settings shape `{instances: [{name, edgeConfigId, ...}]}` (not flat top-level fields)
  - Delegate descriptors with `adobe-alloy::` prefix (not `com.adobe.alloy::`)
  - Identity-map descriptor uses `identity-map` (kebab-case)
  - `set-variable` renamed to `update-variable`
  - Custom-code DE schema rejects `language` field
  - Identity-map settings have NO `cacheLifetime` / `storageDuration` wrapper
  - Rule components POST to `/properties/{id}/rule_components` (not `/rules/{id}/rule_components`)
  - Send Event needs `instanceName: "alloy"` and `xdm` must be a `%DE name%` string ref
  - Library uses revision model (PATCH-revise heads, attach via per-type relationship endpoints)
  - Datastream API is at `edge.adobe.io/metadata/...` with `x-api-key: Activation-DTM` (not `platform.adobe.io/data/core/edge/datastreams`)
  - Embed URL formed as `https://assets.adobedtm.com/{library_path}/{library_entry_points[0].library_name}`
