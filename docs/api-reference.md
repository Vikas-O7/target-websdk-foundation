# API Reference

All 20 tools exposed by the Target Web SDK Foundation MCP server.

**Conventions**:
- *Required* parameters have no default
- *Optional* parameters show their default in `[brackets]`
- Returns describe key fields; the full JSON includes additional metadata

---

## Datastreams (4 tools)

### `list_datastreams`
List all AEP datastreams in the configured sandbox with their enabled service types.

| Param | Type | Default | Description |
|---|---|---|---|
| `nameFilter` | string | *optional* | Case-insensitive substring match on datastream name |

**Returns**: `{ datastreams: [{id, name, services[]}], count }`

---

### `create_datastream`
Create a new AEP datastream. Services are added via separate `add_*_to_datastream` calls.

| Param | Type | Default | Description |
|---|---|---|---|
| `name` | string | *required* | Datastream display name |
| `description` | string | `""` | Optional description |
| `targetMigrationEnabled` | boolean | `false` | Set true ONLY when running at.js in parallel with Web SDK during a migration |

**Returns**: `{ datastreamId, name, status: "created" }`

---

### `add_target_to_datastream`
Enable the Adobe Target service on a datastream (or update it). Required before Web SDK can deliver Target activities.

| Param | Type | Default | Description |
|---|---|---|---|
| `datastreamId` | string | *required* | Target datastream ID |
| `clientCode` | string | *required* | Adobe Target client code (deprecated input — Target tenant is org-level; field accepted for backward compat) |
| `propertyToken` | string | *optional* | `at_property` token for workspace isolation |
| `environment` | enum | `"production"` | `production` / `staging` / `development` |
| `timeoutMs` | int | `5000` | Target API timeout |
| `a4tEnabled` | boolean | `false` | Enable Analytics for Target (requires Analytics service also configured) |

**Returns**: `{ success, service: "Target", property_token, updated }`

---

### `add_analytics_to_datastream`
Enable the Adobe Analytics service on a datastream. Required for A4T.

| Param | Type | Default | Description |
|---|---|---|---|
| `datastreamId` | string | *required* | |
| `reportSuites` | string[] | *required* | One or more Analytics report suite IDs |
| `trackingServer` | string | *required* | Accepted but no longer stored on the datastream by Adobe (kept for backward compat) |
| `sslTrackingServer` | string | *optional* | Same — accepted but not stored |

**Returns**: `{ success, service: "Analytics", report_suites, updated }`

---

## Property setup (8 tools)

### `list_properties`
List all Tags (Launch) properties in the org.

| Param | Type | Default | Description |
|---|---|---|---|
| `nameFilter` | string | *optional* | Case-insensitive substring match on property name |

**Returns**: `{ properties: [{id, name, platform, domains[], enabled}], count }`

---

### `create_tags_property`
Create a new Tags property. Returns existing one if name matches and `returnIfExists: true`.

| Param | Type | Default | Description |
|---|---|---|---|
| `name` | string | *required* | Display name (e.g. "Luma - Target WebSDK") |
| `domains` | string[] | *required* | Apex/canonical domains (e.g. `["luma.com", "www.luma.com"]`) |
| `returnIfExists` | boolean | `true` | Return existing property if name collision |

**Returns**: `{ propertyId, name, alreadyExisted }`

---

### `setup_property_infrastructure`
Create the Akamai (Adobe-managed) host and all three environments (Development, Staging, Production) for a Tags property.

| Param | Type | Default | Description |
|---|---|---|---|
| `propertyId` | string | *required* | |

**Returns**:
```json
{
  "hostId": "HT...",
  "environments": {
    "development": { "id": "EN...", "scriptUrl": "...", "embedCode": "<script ...>" },
    "staging":     { "id": "EN...", ... },
    "production":  { "id": "EN...", ... }
  }
}
```

---

### `install_websdk_extension`
Install and configure the AEP Web SDK (alloy) extension, wired to the given datastream.

| Param | Type | Default | Description |
|---|---|---|---|
| `propertyId` | string | *required* | |
| `datastreamId` | string | *required* | |
| `orgId` | string | from `ADOBE_ORG_ID` env | Adobe Org ID |
| `flickerStyle` | string | `body { opacity: 0 !important }` | CSS rule for prehiding |
| `idMigrationEnabled` | boolean | `false` | Migration from at.js |
| `targetMigrationEnabled` | boolean | `false` | Parallel at.js + Web SDK mode |
| `defaultConsent` | enum | `"in"` | `in` / `pending` |
| `thirdPartyCookies` | boolean | `false` | |

**Returns**: `{ extensionId, packageName, version, datastreamId, alreadyInstalled }`

---

### `create_standard_data_elements`
Create the 10 standard data elements required for Target Web SDK (page context, identity map, XDM page view, Target profile attrs, etc.). Idempotent — skips DEs that already exist by name.

| Param | Type | Default | Description |
|---|---|---|---|
| `propertyId` | string | *required* | |
| `alloyExtensionId` | string | *required* | From `install_websdk_extension` |
| `coreExtensionId` | string | *required* | Reactor auto-installs core; find via `get_property_status` |
| `pageNameDataLayerPath` | string | `digitalData.page.pageInfo.pageName` | |
| `crmIdDataLayerPath` | string | `digitalData.user[0].profile[0].profileInfo.profileID` | |
| `orderIdPath` | string | `digitalData.transaction.transactionID` | Only used if includeOrderDes |
| `orderTotalPath` | string | `digitalData.transaction.total.basePrice` | Only used if includeOrderDes |
| `includeOrderDes` | boolean | `false` | Add order-confirmation DEs |

**Returns**: `{ created: [{name, id, index}], skipped: [{name, reason}], total }`

---

### `create_standard_rules`
Create the standard rules for Target Web SDK. At minimum: page-load Send Event with `renderDecisions: true`. Optionally adds order-confirmation, SPA view-change, click-tracking rules.

| Param | Type | Default | Description |
|---|---|---|---|
| `propertyId` | string | *required* | |
| `alloyExtensionId` | string | *required* | |
| `coreExtensionId` | string | *required* | |
| `renderDecisions` | boolean | `true` | Auto-render Target propositions |
| `includeOrderRule` | boolean | `false` | Add purchase-event rule for order-confirmation page |
| `includeSpaRule` | boolean | `false` | Add SPA view-change rule |
| `includeClickRule` | boolean | `false` | Add click-tracking rule |
| `orderPagePath` | string | `/order-confirmation` | Order-confirmation URL path pattern |

**Returns**: `{ created: [{name, ruleId, components}], skipped }`

---

### `get_property_status`
Complete overview of a Tags property: installed extensions, data element count, rule count, environments with embed codes.

| Param | Type | Default | Description |
|---|---|---|---|
| `propertyId` | string | *required* | |

**Returns**: `{ property_id, name, extensions, data_element_count, rule_count, environments }`

---

### `get_embed_code`
Get the `<script>` embed tag for a specific environment.

| Param | Type | Default | Description |
|---|---|---|---|
| `environmentId` | string | *required* | From `setup_property_infrastructure` or `get_property_status` |

**Returns**: `{ environment_id, stage, embed_code, script_url, instructions }`

---

## Library (2 tools)

### `create_dev_library`
Composite — create a development library, attach all property resources (extensions + DEs + rules), trigger a build, poll until complete, return the dev embed code. Build typically takes 10-60 seconds.

| Param | Type | Default | Description |
|---|---|---|---|
| `propertyId` | string | *required* | |
| `devEnvironmentId` | string | *required* | |
| `libraryName` | string | `Target WebSDK Setup - YYYY-MM-DD` | |
| `buildTimeoutSeconds` | int | `120` | Max wait for build |

**Returns**: `{ library_id, build_id, build_status, build_duration_seconds, embed_code, script_url, resources_added }`

---

### `get_dev_library_status`
Current dev-library status: last build time, status, resource counts.

| Param | Type | Default | Description |
|---|---|---|---|
| `propertyId` | string | *required* | |

**Returns**: `{ library_id, library_name, state, last_build, resource_counts }`

---

## Validation (5 tools)

### `validate_datastream`
Validate a datastream's Target service config (structural — no live traffic).

| Param | Type | Default | Description |
|---|---|---|---|
| `datastreamId` | string | *required* | |

**Returns**: `{ datastream_id, checks[], overall, critical_failures, warnings }`

---

### `validate_tags_property`
Validate a Tags property has all required components: Web SDK extension installed + enabled, required DEs, page-load rule with Send Event + renderDecisions, dev library built.

| Param | Type | Default | Description |
|---|---|---|---|
| `propertyId` | string | *required* | |
| `expectedDatastreamId` | string | *optional* | If provided, asserts Web SDK is wired to this datastream |

**Returns**: `{ property_id, checks[], overall, critical_failures, warnings }`

---

### `test_edge_network`
Send a live test event to Adobe Edge Network. Real HTTP call from the MCP — no browser, no auth headers. Proves datastream → Target connection is live.

| Param | Type | Default | Description |
|---|---|---|---|
| `datastreamId` | string | *required* | |
| `testPageName` | string | `"MCP Validation Test"` | |
| `testUrl` | string | `"https://mcp-validation.local"` | |
| `waitForPropagationSeconds` | int | `0` | **Set to 90 after creating a new datastream.** Max seconds to wait for Edge propagation when datastream is reachable but Target hasn't started responding yet. |
| `pollIntervalSeconds` | int | `15` | Seconds between propagation retries |

**Returns**: `{ datastream_id, http_status, checks: {edge_reachable, identity_assigned, target_responding, target_has_activities, location_hint_returned}, interpretation, raw_handle_types, overall_status, summary, propagation_retries?, propagation_wait_seconds? }`

**Note**: `target_has_activities: false` is NORMAL unless an active Target activity targets the test URL. What matters is `target_responding: true`.

---

### `check_website_implementation`
Fetch a website URL and check whether the Tags embed script is present in the served HTML. Raw fetch + regex (no browser).

| Param | Type | Default | Description |
|---|---|---|---|
| `websiteUrl` | string | *required* | |
| `expectedScriptUrl` | string | *optional* | From `get_embed_code`; verifies deployed script matches |

**Returns**: `{ website_url, http_status, checks: {tagsEmbedPresent, foundTagsUrl, correctScriptUrl, scriptIsAsync, atjsConflictDetected, mcidConflictDetected, acdlPresent, alloyDirectInclude}, warnings, overall, summary }`

---

### `run_full_validation`
Composite — runs all 4 validators and produces an A-F scored report.

| Param | Type | Default | Description |
|---|---|---|---|
| `datastreamId` | string | *required* | |
| `propertyId` | string | *required* | |
| `websiteUrl` | string | *optional* | If provided, also checks website HTML |
| `expectedScriptUrl` | string | *optional* | |

**Returns**: `{ score, grade, sections: {datastream, tags_property, edge_network_live_test, website?}, critical_failures, warnings, recommended_actions, summary }`

---

## Orchestration (1 tool)

### `setup_target_websdk`
**The full wizard.** One call: zero credentials → working dev embed code. Runs the 9-step flow (datastream → Target service → property → host + envs → Web SDK install → DEs → rules → library + build → optional validation). On any step failure, returns partial progress so the run is resumable.

| Param | Type | Default | Description |
|---|---|---|---|
| `datastreamName` | string | *required* | |
| `targetClientCode` | string | *required* | Accepted for backward compat; Target tenant is actually org-level |
| `targetPropertyToken` | string | *optional* | `at_property` token |
| `includeA4t` | boolean | `false` | Add Analytics service for A4T |
| `reportSuites` | string[] | *optional* | Required if `includeA4t` is true |
| `trackingServer` | string | *optional* | Required if `includeA4t` is true (accepted for backward compat) |
| `propertyName` | string | *required* | |
| `domains` | string[] | *required* | |
| `flickerStyle` | string | `body { opacity: 0 !important }` | |
| `pageNamePath` | string | `digitalData.page.pageInfo.pageName` | |
| `crmIdPath` | string | `digitalData.user[0].profile[0].profileInfo.profileID` | |
| `includeOrderDes` | boolean | `false` | |
| `renderDecisions` | boolean | `true` | |
| `includeOrderRule` | boolean | `false` | |
| `orderPagePath` | string | `/order-confirmation` | |
| `libraryName` | string | `Target WebSDK Setup - YYYY-MM-DD` | |
| `runValidation` | boolean | `true` | |

**Returns**: `{ status, progress[], datastream_id, property_id, environments, extensions, data_elements_created, rules_created, library, validation, dev_embed_code, next_steps[] }`

On failure, returns `{ status: "partial_failure", failed_at_step, failure_details, progress[], ...partial_ids, next_steps }`.

See [examples/one-shot-setup.md](../examples/one-shot-setup.md) for a complete invocation example.
