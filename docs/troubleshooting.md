# Troubleshooting

If a tool errors, the MCP returns the full Adobe API response including HTTP status, URL, and error detail. Match the symptom below to find the cause.

## Auth & credentials

### `IMS token exchange failed (400)` or `(401)`
- **Cause**: Wrong CLIENT_ID, CLIENT_SECRET, ORG_ID, or expired credential.
- **Fix**: Re-copy values from Adobe Developer Console. Confirm ORG_ID ends with `@AdobeOrg`.

### `403221 "Token not allowed in the current context"` on any Reactor or AEP call
- **Cause**: Credential technical account is missing a required **product profile** assignment in Admin Console.
- **Fix**: See [adobe-developer-console-setup.md](adobe-developer-console-setup.md) §4.

### `403 "Api key is invalid"` on `list_datastreams` or `create_datastream`
- **Cause**: The MCP version is sending the wrong `x-api-key` to the Edge Metadata API. Should never happen on a release build.
- **Fix**: Open an issue with the version number.

## Datastream API errors

### `404 (openresty HTML body)` on Platform/datastream endpoints
- **Cause**: Either AEP product not added to the Dev Console project, OR your `ADOBE_SANDBOX_NAME` doesn't exist.
- **Fix**: Verify in AEP UI that the sandbox name matches your `.env`.

### `400 EXEG-3036 "Api key is invalid"` on Edge calls
- **Cause**: Same as 403 above — internal bug if you hit it.

### Datastream just created but `target_responding: false`
- **Cause**: Edge Network propagation lag (~30–60 seconds for new datastreams).
- **Fix**: Pass `waitForPropagationSeconds: 90` to `test_edge_network`, or wait and retry.

### `Datastream creation succeeded but no id returned`
- **Cause**: Adobe response shape changed.
- **Fix**: Open an issue with the response JSON the MCP captured.

## Reactor / Tags property errors

### `GET /properties → 404`
- **Cause**: Adobe deprecated the root-level `/properties` endpoint. The MCP correctly uses `/companies/{id}/properties`; this error means the company-id resolution failed.
- **Fix**: Try `list_properties` first — if THAT returns "no companies found", your credential lacks the Launch admin profile (see setup doc §4).

### `409 "Invalid extension ... needs to be revised"` from `create_dev_library`
- **Cause**: Edge case where one of the resources can't be revised (likely already revised in a parallel build).
- **Fix**: Retry `create_dev_library` — the de-dupe should pick it up.

### `409 "duplicate name"` on `create_tags_property`
- **Cause**: A property with that name already exists.
- **Fix**: The MCP returns the existing property by default (`returnIfExists: true`). If you want a new property, pick a different name.

### `400 Schema Validation Error: privacy ... did not match`
- **Cause**: Adobe changed the `privacy` field accepted values.
- **Fix**: Open an issue. The MCP sends `"unknown"` which works as of 2026.

### `409 Invalid settings ... delegate_descriptor_id is required`
- **Cause**: Should never happen on a release build (MCP always sends descriptor).
- **Fix**: Open an issue.

## Web SDK extension errors

### `Extension package not found in Reactor catalog: adobe-alloy`
- **Cause**: Your Reactor company doesn't have public extension catalog access.
- **Fix**: Contact Adobe support. Most orgs have this enabled by default.

### `409 Invalid settings ... of type object did not match any of the required schemas`
- **Cause**: Adobe changed the Web SDK settings schema.
- **Fix**: Open an issue. The MCP sends `{instances: [{name, edgeConfigId, ...}]}` which is current as of 2026.

## Data element / rule errors

### `409 contains an additional property "language" outside of the schema`
- **Cause**: Old release. The MCP no longer sends `language`.
- **Fix**: Update to the latest version: `npm update -g target-websdk-foundation`.

### `409 "did not match one of the following values: loggedOut, authenticated, ambiguous"`
- **Cause**: An identity-map `authenticatedState` field is being sent as a `%DE name%` template, which fails enum validation.
- **Fix**: The MCP omits this field intentionally. If you customized the identity map, remove `authenticatedState`.

### `405 "Method not allowed"` on rule-component creation
- **Cause**: Old release using the wrong endpoint path.
- **Fix**: Update to latest.

### `409 "instanceName is required"` on Send Event rules
- **Cause**: Old release. Current MCP sends `instanceName: "alloy"` automatically.
- **Fix**: Update to latest.

## Library / build errors

### `409 "needs to be revised"` errors during library build
- **Cause**: Resources weren't revised before attach.
- **Fix**: The MCP revises automatically. If you hit this, open an issue.

### `404 on POST /libraries/{id}/relationships/resources`
- **Cause**: Old release using deprecated unified-resources endpoint.
- **Fix**: Update — current MCP uses per-type endpoints (`/relationships/extensions`, `/data_elements`, `/rules`).

### Build status: `timeout`
- **Cause**: Build took longer than `buildTimeoutSeconds` (default 120s).
- **Fix**: Re-call `create_dev_library` with `buildTimeoutSeconds: 240`. Builds rarely take >2 min but spikes happen.

### Build status: `failed`
- **Cause**: A resource has invalid configuration (e.g., a rule references a DE that no longer exists).
- **Fix**: Read `failed_details` in the response. Often points to the specific resource.

## Edge Network / verification errors

### `target_responding: false` after waiting
- **Causes** (most likely first):
  - Target service not actually enabled on the datastream (call `validate_datastream`)
  - Datastream `enabled: false` flag
  - Different IMS org for the datastream vs. your Adobe Target tenant
- **Fix**: Check `get_property_status` and `validate_datastream` outputs.

### `identity_assigned: false` but everything else works
- **Cause**: Usually no problem. Adobe Edge occasionally skips identity:result if the request looks unauthenticated; the actual SDK call from a browser will get identity.

### `Tags embed script is NOT present` from `check_website_implementation`
- **Cause**: You haven't deployed the dev embed code to the website yet, OR the page you tested doesn't have the script in `<head>`.
- **Fix**: Deploy the `<script>` tag and reload.

## "I just don't see my data in Target Reports"

This MCP gets you to a working *implementation* — i.e., Target activities CAN be delivered through this datastream. Getting actual data in reports requires:
- Active activities targeting URLs the SDK loads on
- Real users hitting those pages
- Time (~30–60 minutes for Target Reports to surface)

If `test_edge_network` shows `target_responding: true` and you've deployed the embed code, the implementation is done. Reporting delays are a Target product behavior, not an implementation issue.

---

## Known issues

There are no open known issues against the current release.

### Legacy v1.0 properties may carry a duplicate Development env

**Symptom**: A property created with v1.0 of this MCP can carry an extra `development`-stage environment from the original (non-idempotent) setup. Visible in the Tags UI as two `Development` rows; the orchestrator output collapses them and shows only one because `get_property_status` keys by stage.

**Cause**: v1.0's `setup_property_infrastructure` POSTed environments without first listing existing ones, so a partial-failure re-run of `setup_target_websdk` would mint a second dev env. Fixed in **v1.1.0** by [`c976d72`](https://github.com/Vikas-O7/target-websdk-foundation/commit/c976d72) (`fix: make setup_target_websdk orchestrator fully idempotent`). v1.1+ correctly reuses existing envs and is safe to re-run.

**Detection**: v1.3.1+ emits a stderr warn log during `setup_target_websdk` re-runs whenever it finds more than one env per stage on a property:

```
[warn] Property PRxxx: 2 development-stage environments found.
       Using oldest (ENaaa). Extras: ENbbb. These are likely artifacts
       of a pre-v1.1 orchestrator bug — safe to delete via the Tags UI
       or DELETE /environments/{id}.
```

**Cleanup**: The orchestrator deterministically picks the **oldest** dev env (by `created_at`) — that's the one your existing libraries are pinned to, so it's safe to leave running. Delete the newer duplicate(s) via the Tags UI (Environments → ⋯ → Delete) or via the Reactor API directly. Confirm no library references the env before deletion.

---

## Filing an issue

Include:
1. MCP version (`target-websdk-foundation --version` or check `package.json`)
2. The tool call that failed (sanitized — redact your bearer token if visible)
3. The full error response from the MCP
4. Output of `validate_datastream` and `validate_tags_property` if relevant

Issues: https://github.com/Vikas-O7/target-websdk-foundation/issues
