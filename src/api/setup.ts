/**
 * Data Collection — Tags property setup.
 *
 * Covers Tags (Launch) property + host + environment + extension + data
 * element + rule creation. See Adobe Reactor / Edge Metadata API.
 *
 * Patterns to remember:
 *   • Every `attributes.settings` MUST be a JSON-encoded string (use
 *     ensureSettingsString() before sending).
 *   • Rule components reference data elements by NAME using `%DE Name%`
 *     syntax, not by ID.
 *   • Each component is a separate POST to /rules/{id}/rule_components.
 *   • Extension package IDs are environment-specific — always look up by
 *     `name` filter, never hardcode.
 */

import {
  reactorRequest,
  reactorPaginate,
  jsonApiCreateBody,
  getId,
  getAttr,
  getReactorCompanyId,
  ensureSettingsString,
  type JsonApiResource,
  type JsonApiSingleResponse,
} from "./reactor-client.js";
import { config } from "../config.js";
import {
  EXTENSION_PACKAGE_NAMES,
  websdkExtensionSettings,
  standardDataElements,
  rcDomReadySettings,
  rcSendEventSettings,
  rcSendPurchaseSettings,
  rcPathConditionSettings,
  rcCustomEventSettings,
  rcSpaSendEventSettings,
  CORE_DESCRIPTORS,
  ALLOY_DESCRIPTORS,
  ALLOY_CONFIG_DESCRIPTOR,
  type WebSdkSettingsInput,
} from "./templates.js";

// ── Types ───────────────────────────────────────────────────
export interface PropertySummary {
  id: string;
  name: string;
  platform: string;
  domains: string[];
  enabled: boolean;
}

// ── List properties ─────────────────────────────────────────
export async function listProperties(
  nameFilter?: string
): Promise<{ properties: PropertySummary[]; count: number }> {
  const params: Record<string, string | undefined> = {};
  if (nameFilter) params["filter[name]"] = `CONTAINS ${nameFilter}`;
  // Reactor's `/properties` root doesn't exist — properties live under their
  // company. Resolve company ID once, then list.
  const companyId = await getReactorCompanyId();
  const raw = await reactorPaginate<{
    name?: string;
    platform?: string;
    domains?: string[];
    enabled?: boolean;
  }>(`/companies/${companyId}/properties`, { params });
  const properties: PropertySummary[] = raw.map((r) => ({
    id: r.id,
    name: r.attributes.name ?? "",
    platform: r.attributes.platform ?? "",
    domains: r.attributes.domains ?? [],
    enabled: r.attributes.enabled ?? false,
  }));
  return { properties, count: properties.length };
}

// ── Create property ─────────────────────────────────────────
export interface CreatePropertyInput {
  name: string;
  domains: string[];
  returnIfExists?: boolean;
}

export async function createTagsProperty(
  input: CreatePropertyInput
): Promise<{ propertyId: string; name: string; alreadyExisted: boolean }> {
  // First check for existing by name — Reactor's `return_if_exists` attribute
  // is undocumented in some setups, so do this manually for safety.
  if (input.returnIfExists !== false) {
    const existing = await listProperties(input.name);
    const match = existing.properties.find((p) => p.name === input.name);
    if (match) {
      return { propertyId: match.id, name: match.name, alreadyExisted: true };
    }
  }

  // Reactor's privacy attribute is a STRING enum: "optedin" | "optedout" |
  // "unknown" (NOT an object — confirmed against live Reactor 2026-06-13).
  // "unknown" lets the consultant configure consent later via Tags UI.
  const body = jsonApiCreateBody("properties", {
    name: input.name,
    platform: "web",
    domains: input.domains,
    ssl_enabled: true,
    privacy: "unknown",
  });

  try {
    const companyId = await getReactorCompanyId();
    const resp = await reactorRequest<JsonApiSingleResponse>(
      `/companies/${companyId}/properties`,
      {
        method: "POST",
        body,
      }
    );
    return {
      propertyId: getId(resp),
      name: input.name,
      alreadyExisted: false,
    };
  } catch (e) {
    // 409 → race — re-search and return existing.
    const msg = (e as Error).message;
    if (/409/.test(msg) && input.returnIfExists !== false) {
      const existing = await listProperties(input.name);
      const match = existing.properties.find((p) => p.name === input.name);
      if (match) {
        return {
          propertyId: match.id,
          name: match.name,
          alreadyExisted: true,
        };
      }
    }
    throw e;
  }
}

// ── Property infrastructure (host + environments) ──────────
export interface EnvironmentEmbed {
  id: string;
  embedCode: string;
  scriptUrl: string;
}

export interface PropertyInfrastructure {
  hostId: string;
  environments: {
    development: EnvironmentEmbed;
    staging: EnvironmentEmbed;
    production: EnvironmentEmbed;
  };
}

/**
 * Reactor returns `library_path` as a bare path-suffix
 * (e.g. "6268dc4b6b26/0dfa9865ec72"), NOT as `//assets.adobedtm.com/...`
 * as the spec described. To form a working script URL, prepend the CDN
 * host AND append the library filename from `library_entry_points`.
 *
 * Some callers only have `library_path` (no entry points handy). In that
 * case the resulting URL points to a directory, not a file — which will
 * 404 when used as a `<script src>`. So `libraryFilename` is best-effort
 * optional; when provided, the URL is complete and immediately usable.
 *
 * Schema confirmed live 2026-06-13:
 *   environments.attributes.library_path           = "6268dc4b6b26/0dfa9865ec72"
 *   environments.attributes.library_entry_points[0].library_name
 *                                                  = "launch-c38f9ce8763b-development.min.js"
 *   full URL: https://assets.adobedtm.com/<library_path>/<library_name>
 */
const TAGS_CDN = "https://assets.adobedtm.com";

function buildEmbed(
  libraryPath: string,
  libraryFilename?: string
): { embedCode: string; scriptUrl: string } {
  // Strip leading "//" if Reactor ever returns a protocol-relative form
  // (defensive; current behavior is bare path-suffix).
  const cleanPath = libraryPath.replace(/^\/\//, "").replace(/^https?:/i, "");
  // Avoid double slashes.
  const base = `${TAGS_CDN}/${cleanPath.replace(/^\/+/, "")}`;
  const scriptUrl = libraryFilename
    ? `${base.replace(/\/+$/, "")}/${libraryFilename}`
    : base;
  return {
    scriptUrl,
    embedCode: `<script src="${scriptUrl}" async></script>`,
  };
}

/**
 * Extract the production-bundled `.min.js` filename from an environment
 * attributes record (Reactor returns multiple entry points; we pick the
 * minified one — same as the Tags UI does).
 */
function pickLibraryFilename(envAttrs: Record<string, unknown>): string | undefined {
  const entries = envAttrs.library_entry_points;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const e = entry as { library_name?: string; minified?: boolean };
    if (e.minified === true && e.library_name) return e.library_name;
  }
  // Fall back to library_name on the env if present.
  return (envAttrs as { library_name?: string }).library_name;
}

async function envEmbedFromDetail(
  envDetail: JsonApiSingleResponse
): Promise<EnvironmentEmbed> {
  const envId = getId(envDetail);
  const libraryPath = getAttr<string>(envDetail, "library_path") ?? "";
  const envAttrs = (envDetail as { data?: { attributes?: Record<string, unknown> } })
    .data?.attributes;
  const libFilename = envAttrs ? pickLibraryFilename(envAttrs) : undefined;
  const { scriptUrl, embedCode } = buildEmbed(libraryPath, libFilename);
  return { id: envId, scriptUrl, embedCode };
}

export async function setupPropertyInfrastructure(
  propertyId: string
): Promise<PropertyInfrastructure> {
  // 1. Host — reuse existing Akamai host if one exists, else create.
  // Reactor allows only one host per type on a property; calling POST a
  // second time would 409. Idempotency confirmed live 2026-06.
  const existingHosts = await reactorPaginate<{ type_of?: string }>(
    `/properties/${propertyId}/hosts`
  );
  let hostId: string;
  const existingAkamai = existingHosts.find(
    (h) => (h.attributes as { type_of?: string }).type_of === "akamai"
  );
  if (existingAkamai) {
    hostId = existingAkamai.id;
  } else {
    const hostBody = jsonApiCreateBody("hosts", {
      name: "Adobe Managed",
      type_of: "akamai",
    });
    const hostResp = await reactorRequest<JsonApiSingleResponse>(
      `/properties/${propertyId}/hosts`,
      { method: "POST", body: hostBody }
    );
    hostId = getId(hostResp);
  }

  // 2. Environments — fetch existing, then per stage either reuse or create.
  // Reactor allows only ONE environment per stage; creating a duplicate 409s
  // with "only one staging environment can be added to a property".
  const existingEnvs = await reactorPaginate<{ stage?: string }>(
    `/properties/${propertyId}/environments`
  );
  const envByStage = new Map<string, string>();
  for (const e of existingEnvs) {
    const stage = (e.attributes as { stage?: string }).stage;
    if (stage) envByStage.set(stage, e.id);
  }

  const stages: Array<{ stage: "development" | "staging" | "production"; display: string }> = [
    { stage: "development", display: "Development" },
    { stage: "staging", display: "Staging" },
    { stage: "production", display: "Production" },
  ];

  const created: Partial<PropertyInfrastructure["environments"]> = {};
  for (const s of stages) {
    let envId = envByStage.get(s.stage);
    if (!envId) {
      const envBody = {
        data: {
          type: "environments",
          attributes: { name: s.display, stage: s.stage },
          relationships: {
            host: { data: { id: hostId, type: "hosts" } },
          },
        },
      };
      const envResp = await reactorRequest<JsonApiSingleResponse>(
        `/properties/${propertyId}/environments`,
        { method: "POST", body: envBody }
      );
      envId = getId(envResp);
    }
    // Always fetch full detail for library_path + library_entry_points
    const envDetail = await reactorRequest<JsonApiSingleResponse>(
      `/environments/${envId}`
    );
    created[s.stage] = await envEmbedFromDetail(envDetail);
  }

  return {
    hostId,
    environments: {
      development: created.development!,
      staging: created.staging!,
      production: created.production!,
    },
  };
}

// ── Extension package discovery ─────────────────────────────
async function findExtensionPackageId(packageName: string): Promise<string> {
  const params = {
    "filter[name]": `EQ ${packageName}`,
    "filter[availability]": "EQ public",
    sort: "-version",
  };
  const results = await reactorPaginate<{ name?: string; version?: string }>(
    "/extension_packages",
    { params }
  );
  if (results.length === 0) {
    throw new Error(
      `Extension package not found in Reactor catalog: ${packageName}. Confirm the package name is correct and that your Dev Console integration has access.`
    );
  }
  return results[0].id;
}

async function listInstalledExtensions(
  propertyId: string
): Promise<JsonApiResource[]> {
  return await reactorPaginate(`/properties/${propertyId}/extensions`);
}

async function getCoreExtensionId(propertyId: string): Promise<string> {
  // Server-side filtering by `filter[extension_package_name]` does NOT
  // work as expected — Reactor returns ALL extensions (or behavior is
  // unspecified) because `extension_package_name` is undefined on
  // extension *instances* (the field only exists on the catalog records).
  // List unfiltered and match client-side on `attributes.name`. Confirmed
  // live 2026-06.
  const exts = await reactorPaginate<{
    name?: string;
    extension_package_name?: string;
  }>(`/properties/${propertyId}/extensions`);
  const core = exts.find((e) => {
    const a = e.attributes;
    return a.name === "core" || a.extension_package_name === "core";
  });
  if (!core) {
    throw new Error(
      `Core extension not found on property ${propertyId}. This is unexpected — Reactor normally auto-installs the core extension on every property.`
    );
  }
  return core.id;
}

// ── Install Web SDK extension ──────────────────────────────
export interface InstallWebSdkInput extends Omit<WebSdkSettingsInput, "orgId"> {
  propertyId: string;
  orgId?: string;
}

export async function installWebSdkExtension(input: InstallWebSdkInput): Promise<{
  extensionId: string;
  packageName: string;
  version: string;
  datastreamId: string;
  alreadyInstalled: boolean;
}> {
  // Check whether alloy is already installed.
  // Reactor returns the package identifier as `attributes.name` on extension
  // instances (NOT `extension_package_name`, which is `undefined`). We check
  // both for safety across API versions. Confirmed live 2026-06.
  const installed = await listInstalledExtensions(input.propertyId);
  const existing = installed.find((e) => {
    const a = e.attributes as { name?: string; extension_package_name?: string };
    return (
      a.name === EXTENSION_PACKAGE_NAMES.websdk ||
      a.extension_package_name === EXTENSION_PACKAGE_NAMES.websdk
    );
  });
  if (existing) {
    return {
      extensionId: existing.id,
      packageName: EXTENSION_PACKAGE_NAMES.websdk,
      version:
        (existing.attributes as { version?: string }).version ?? "unknown",
      datastreamId: input.datastreamId,
      alreadyInstalled: true,
    };
  }

  const packageId = await findExtensionPackageId(EXTENSION_PACKAGE_NAMES.websdk);
  const settings = websdkExtensionSettings({
    ...input,
    orgId: input.orgId ?? config.ADOBE_ORG_ID,
  });

  // Reactor requires `delegate_descriptor_id` when `attributes.settings` is
  // present — it points at the extension's configuration descriptor. For
  // adobe-alloy this is `adobe-alloy::extensionConfiguration::config`.
  // Without it, Reactor rejects with 409 "delegate_descriptor_id is required
  // when settings are present".
  const body = {
    data: {
      type: "extensions",
      attributes: {
        delegate_descriptor_id: ALLOY_CONFIG_DESCRIPTOR,
        settings: ensureSettingsString(settings),
        enabled: true,
      },
      relationships: {
        extension_package: {
          data: { id: packageId, type: "extension_packages" },
        },
      },
    },
  };

  const resp = await reactorRequest<JsonApiSingleResponse>(
    `/properties/${input.propertyId}/extensions`,
    { method: "POST", body }
  );

  return {
    extensionId: getId(resp),
    packageName: EXTENSION_PACKAGE_NAMES.websdk,
    version: getAttr<string>(resp, "version") ?? "unknown",
    datastreamId: input.datastreamId,
    alreadyInstalled: false,
  };
}

// ── Resolve extension IDs after install ─────────────────────
/**
 * After install, helper resolves the alloy + core extension IDs needed by
 * downstream DE / rule creation.
 */
export async function resolveExtensionIds(
  propertyId: string
): Promise<{ alloyExtensionId: string; coreExtensionId: string }> {
  const exts = await listInstalledExtensions(propertyId);
  const alloy = exts.find((e) => {
    const a = e.attributes as { name?: string; extension_package_name?: string };
    return (
      a.name === EXTENSION_PACKAGE_NAMES.websdk ||
      a.extension_package_name === EXTENSION_PACKAGE_NAMES.websdk
    );
  });
  if (!alloy) {
    throw new Error(
      `Web SDK (adobe-alloy) extension not found on property ${propertyId}. Install it first via install_websdk_extension.`
    );
  }
  const core = await getCoreExtensionId(propertyId);
  return { alloyExtensionId: alloy.id, coreExtensionId: core };
}

// ── Create data elements ───────────────────────────────────
export interface CreateStandardDesInput {
  propertyId: string;
  alloyExtensionId: string;
  coreExtensionId: string;
  pageNameDataLayerPath: string;
  crmIdDataLayerPath: string;
  orderIdPath?: string;
  orderTotalPath?: string;
  includeOrderDes?: boolean;
}

export async function createStandardDataElements(
  input: CreateStandardDesInput
): Promise<{
  created: Array<{ name: string; id: string; index: number }>;
  skipped: Array<{ name: string; reason: string }>;
  total: number;
}> {
  const desCatalog = standardDataElements({
    pageNamePath: input.pageNameDataLayerPath,
    crmIdPath: input.crmIdDataLayerPath,
    orderIdPath: input.orderIdPath,
    orderTotalPath: input.orderTotalPath,
    includeOrderDes: input.includeOrderDes,
  });

  // Discover existing DEs by name to avoid duplicates
  const existing = await reactorPaginate<{ name?: string }>(
    `/properties/${input.propertyId}/data_elements`
  );
  const existingByName = new Map<string, string>(
    existing.map((e) => [(e.attributes as { name?: string }).name ?? "", e.id])
  );

  const created: Array<{ name: string; id: string; index: number }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  let index = 0;
  for (const de of desCatalog) {
    if (existingByName.has(de.name)) {
      skipped.push({
        name: de.name,
        reason: `Already exists with id ${existingByName.get(de.name)}`,
      });
      created.push({
        name: de.name,
        id: existingByName.get(de.name)!,
        index,
      });
      index++;
      continue;
    }

    const extensionId =
      de.extension === "alloy" ? input.alloyExtensionId : input.coreExtensionId;

    const attributes: Record<string, unknown> = {
      name: de.name,
      delegate_descriptor_id: de.delegateDescriptorId,
      settings: ensureSettingsString(de.settings),
      enabled: true,
      default_value: de.defaultValue ?? "",
      force_lower_case: false,
      clean_text: false,
      storage_duration: de.storageDuration,
    };
    const body = {
      data: {
        type: "data_elements",
        attributes,
        relationships: {
          extension: { data: { id: extensionId, type: "extensions" } },
        },
      },
    };
    const resp = await reactorRequest<JsonApiSingleResponse>(
      `/properties/${input.propertyId}/data_elements`,
      { method: "POST", body }
    );
    created.push({ name: de.name, id: getId(resp), index });
    index++;
  }

  return { created, skipped, total: created.length };
}

// ── Create rules ───────────────────────────────────────────
export interface CreateStandardRulesInput {
  propertyId: string;
  alloyExtensionId: string;
  coreExtensionId: string;
  renderDecisions?: boolean;
  includeOrderRule?: boolean;
  includeSpaRule?: boolean;
  includeClickRule?: boolean;
  orderPagePath?: string;
}

interface RuleResult {
  name: string;
  ruleId: string;
  components: number;
}

async function createOneRuleComponent(
  propertyId: string,
  body: Record<string, unknown>
): Promise<string> {
  // Reactor: rule_components are CREATED at the property scope. The
  // `/rules/{id}/rule_components` path is GET-only (lists components
  // attached to a rule). The body's relationships.rules array tells
  // Reactor which rule(s) to attach the component to.
  const resp = await reactorRequest<JsonApiSingleResponse>(
    `/properties/${propertyId}/rule_components`,
    { method: "POST", body }
  );
  return getId(resp);
}

function ruleComponentBody(opts: {
  extensionId: string;
  componentType: "events" | "conditions" | "actions";
  delegateDescriptorId: string;
  settings: string;
  name?: string;
  order?: number;
  ruleOrder?: number;
  negate?: boolean;
  timeout?: number;
  ruleId: string;
}): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    delegate_descriptor_id: opts.delegateDescriptorId,
    name: opts.name ?? "",
    order: opts.order ?? 0,
    rule_order: opts.ruleOrder ?? 50,
    settings: ensureSettingsString(opts.settings),
    negate: opts.negate ?? false,
  };
  if (opts.timeout !== undefined) attributes.timeout = opts.timeout;
  // The component_type is conveyed via the resource type itself in some
  // Reactor versions; we mirror the spec which uses "rule_components" as the
  // type for events/conditions/actions alike.
  void opts.componentType;
  return {
    data: {
      type: "rule_components",
      attributes,
      relationships: {
        extension: {
          data: { id: opts.extensionId, type: "extensions" },
        },
        rules: {
          data: [{ id: opts.ruleId, type: "rules" }],
        },
      },
    },
  };
}

async function createRule(
  propertyId: string,
  name: string
): Promise<string> {
  const body = jsonApiCreateBody("rules", { name, enabled: true });
  const resp = await reactorRequest<JsonApiSingleResponse>(
    `/properties/${propertyId}/rules`,
    { method: "POST", body }
  );
  return getId(resp);
}

export async function createStandardRules(
  input: CreateStandardRulesInput
): Promise<{ created: RuleResult[]; skipped: Array<{ name: string; reason: string }> }> {
  const created: RuleResult[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  // De-dupe — check existing rule names
  const existingRules = await reactorPaginate<{ name?: string }>(
    `/properties/${input.propertyId}/rules`
  );
  const existingNames = new Set(
    existingRules.map((r) => (r.attributes as { name?: string }).name ?? "")
  );

  // Rule 1 — Page Load
  const r1Name = "All Pages - Target WebSDK - Page Load";
  if (existingNames.has(r1Name)) {
    skipped.push({ name: r1Name, reason: "Already exists" });
  } else {
    const r1Id = await createRule(input.propertyId, r1Name);
    let comps = 0;
    // Event: DOM Ready
    await createOneRuleComponent(
      input.propertyId,
      ruleComponentBody({
        ruleId: r1Id,
        extensionId: input.coreExtensionId,
        componentType: "events",
        delegateDescriptorId: CORE_DESCRIPTORS.dom_ready,
        settings: rcDomReadySettings(),
        name: "DOM Ready",
        timeout: 2000,
      })
    );
    comps++;
    // Action: Send Event
    await createOneRuleComponent(
      input.propertyId,
      ruleComponentBody({
        ruleId: r1Id,
        extensionId: input.alloyExtensionId,
        componentType: "actions",
        delegateDescriptorId: ALLOY_DESCRIPTORS.send_event,
        settings: rcSendEventSettings(
          "XDM - Page View",
          "Target - Profile Attributes",
          "Target - mbox3rdPartyId",
          input.renderDecisions ?? true
        ),
        name: "Send Page View Event",
      })
    );
    comps++;
    created.push({ name: r1Name, ruleId: r1Id, components: comps });
  }

  // Rule 2 — Order confirmation
  if (input.includeOrderRule) {
    const r2Name = "Order Confirmation - Target - Purchase";
    if (existingNames.has(r2Name)) {
      skipped.push({ name: r2Name, reason: "Already exists" });
    } else {
      const r2Id = await createRule(input.propertyId, r2Name);
      let comps = 0;
      await createOneRuleComponent(
        input.propertyId,
        ruleComponentBody({
          ruleId: r2Id,
          extensionId: input.coreExtensionId,
          componentType: "events",
          delegateDescriptorId: CORE_DESCRIPTORS.dom_ready,
          settings: rcDomReadySettings(),
          name: "DOM Ready",
          timeout: 2000,
        })
      );
      comps++;
      await createOneRuleComponent(
        input.propertyId,
        ruleComponentBody({
          ruleId: r2Id,
          extensionId: input.coreExtensionId,
          componentType: "conditions",
          delegateDescriptorId: CORE_DESCRIPTORS.path_condition,
          settings: rcPathConditionSettings(
            input.orderPagePath ?? "/order-confirmation",
            false
          ),
          name: "Order Confirmation Page",
        })
      );
      comps++;
      await createOneRuleComponent(
        input.propertyId,
        ruleComponentBody({
          ruleId: r2Id,
          extensionId: input.alloyExtensionId,
          componentType: "actions",
          delegateDescriptorId: ALLOY_DESCRIPTORS.send_event,
          settings: rcSendPurchaseSettings(
            "Order - ID",
            "Order - Total",
            "Order - Products"
          ),
          name: "Send Purchase Event",
        })
      );
      comps++;
      created.push({ name: r2Name, ruleId: r2Id, components: comps });
    }
  }

  // Rule 3 — SPA view change
  if (input.includeSpaRule) {
    const r3Name = "SPA - Target - View Change";
    if (existingNames.has(r3Name)) {
      skipped.push({ name: r3Name, reason: "Already exists" });
    } else {
      const r3Id = await createRule(input.propertyId, r3Name);
      let comps = 0;
      await createOneRuleComponent(
        input.propertyId,
        ruleComponentBody({
          ruleId: r3Id,
          extensionId: input.coreExtensionId,
          componentType: "events",
          delegateDescriptorId: CORE_DESCRIPTORS.custom_event,
          settings: rcCustomEventSettings("spa:viewchange"),
          name: "SPA View Change",
        })
      );
      comps++;
      await createOneRuleComponent(
        input.propertyId,
        ruleComponentBody({
          ruleId: r3Id,
          extensionId: input.alloyExtensionId,
          componentType: "actions",
          delegateDescriptorId: ALLOY_DESCRIPTORS.send_event,
          settings: rcSpaSendEventSettings("Page - Name"),
          name: "Send SPA View Event",
        })
      );
      comps++;
      created.push({ name: r3Name, ruleId: r3Id, components: comps });
    }
  }

  return { created, skipped };
}

// ── Property status / embed code ───────────────────────────
export interface PropertyStatus {
  property_id: string;
  name: string;
  extensions: Array<{ name: string; version: string }>;
  data_element_count: number;
  rule_count: number;
  environments: Record<
    string,
    { id: string; embed_code: string; script_url: string }
  >;
}

export async function getPropertyStatus(
  propertyId: string
): Promise<PropertyStatus> {
  const [propResp, extensions, des, rules, envs] = await Promise.all([
    reactorRequest<JsonApiSingleResponse>(`/properties/${propertyId}`),
    reactorPaginate<{ name?: string; version?: string }>(
      `/properties/${propertyId}/extensions`
    ),
    reactorPaginate(`/properties/${propertyId}/data_elements`),
    reactorPaginate(`/properties/${propertyId}/rules`),
    reactorPaginate<{ stage?: string; library_path?: string }>(
      `/properties/${propertyId}/environments`
    ),
  ]);

  const environments: PropertyStatus["environments"] = {};
  for (const env of envs) {
    const stage =
      (env.attributes as { stage?: string }).stage ?? "unknown";
    const libraryPath =
      (env.attributes as { library_path?: string }).library_path ?? "";
    const libFilename = pickLibraryFilename(
      env.attributes as Record<string, unknown>
    );
    const { embedCode, scriptUrl } = buildEmbed(libraryPath, libFilename);
    environments[stage] = {
      id: env.id,
      embed_code: embedCode,
      script_url: scriptUrl,
    };
  }

  return {
    property_id: propertyId,
    name: getAttr<string>(propResp, "name") ?? "",
    extensions: extensions.map((e) => ({
      name:
        (e.attributes as { name?: string }).name ??
        (e.attributes as { extension_package_name?: string })
          .extension_package_name ??
        "unknown",
      version: (e.attributes as { version?: string }).version ?? "unknown",
    })),
    data_element_count: des.length,
    rule_count: rules.length,
    environments,
  };
}

export async function getEmbedCode(environmentId: string): Promise<{
  environment_id: string;
  stage: string;
  embed_code: string;
  script_url: string;
  instructions: string;
}> {
  const env = await reactorRequest<JsonApiSingleResponse>(
    `/environments/${environmentId}`
  );
  const libraryPath = getAttr<string>(env, "library_path") ?? "";
  const stage = getAttr<string>(env, "stage") ?? "unknown";
  const envAttrs = (env as { data?: { attributes?: Record<string, unknown> } })
    .data?.attributes;
  const libFilename = envAttrs ? pickLibraryFilename(envAttrs) : undefined;
  const { embedCode, scriptUrl } = buildEmbed(libraryPath, libFilename);
  return {
    environment_id: environmentId,
    stage,
    embed_code: embedCode,
    script_url: scriptUrl,
    instructions:
      "Add this script tag to your website's <head>, before any other marketing tags.",
  };
}
