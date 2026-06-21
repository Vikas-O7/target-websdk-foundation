# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
