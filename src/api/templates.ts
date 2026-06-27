/**
 * Data Collection — resource templates.
 *
 * Pure data-shaping functions for the Tags (Launch) + Datastream + Edge
 * Network resources created by the tools in this module. No HTTP calls live here.
 *
 * Ported from `RESOURCE_TEMPLATES_REFERENCE.md` Sections 1–10. Every value
 * that ends up in a Reactor `attributes.settings` field is JSON-stringified
 * here so callers can drop it straight into a JSON:API body.
 *
 * The `%DE Name%` syntax inside settings strings is intentional — Tags
 * resolves data-element references at runtime by name, not by ID.
 */

import { randomUUID } from "node:crypto";

// ── Extension package names (stable across orgs) ───────────────────────
//
// Confirmed live against Reactor catalog 2026-06-13 — the web SDK package
// is `adobe-alloy`, NOT `com.adobe.alloy` as the spec stated. The
// `com.*` form returns zero results; `adobe-alloy` matches the current
// production package + `adobe-alloy-beta` matches the beta channel.
export const EXTENSION_PACKAGE_NAMES = {
  websdk: "adobe-alloy",
  core: "core",
  acdl: "com.adobe.adobe-client-data-layer",
  analytics: "adobe-analytics",
  target_atjs: "adobe-target", // legacy — for migration scans only
} as const;

// ── Delegate descriptor IDs (stable per extension package) ─────────────
export const CORE_DESCRIPTORS = {
  // Events
  library_loaded: "core::events::library-loaded",
  dom_ready: "core::events::dom-ready",
  window_loaded: "core::events::window-loaded",
  click: "core::events::click",
  custom_event: "core::events::custom-event",
  // Conditions
  // NOTE: descriptor is `path-and-querystring` (with "string"). The spec
  // had `path-and-query` which Reactor rejects — confirmed 2026-06-22
  // against core extension package version 3.4.4.
  path_condition: "core::conditions::path-and-querystring",
  custom_code_cond: "core::conditions::custom-code",
  cookie: "core::conditions::cookie",
  data_element: "core::conditions::data-element",
  // Actions
  custom_code_action: "core::actions::custom-code",
  // Data Elements
  js_variable: "core::dataElements::javascript-variable",
  custom_code_de: "core::dataElements::custom-code",
  constant: "core::dataElements::constant",
  cookie_de: "core::dataElements::cookie",
  query_param: "core::dataElements::query-string-parameter",
  page_info: "core::dataElements::page-info",
  local_storage: "core::dataElements::local-storage",
} as const;

// Descriptor IDs confirmed live against Reactor catalog 2026-06-13.
// Prefix is `adobe-alloy::` (not `com.adobe.alloy::`). The
// `identity-map` descriptor uses kebab-case (not `identityMap`).
// `set-variable` was renamed to `update-variable`; `get-identity` and
// `reset-identity` no longer exist in the catalog.
//
// `extensionConfiguration::config` is the descriptor for the extension
// install itself — required when posting settings.
export const ALLOY_CONFIG_DESCRIPTOR = "adobe-alloy::extensionConfiguration::config";

export const ALLOY_DESCRIPTORS = {
  // Actions
  send_event: "adobe-alloy::actions::send-event",
  apply_propositions: "adobe-alloy::actions::apply-propositions",
  apply_response: "adobe-alloy::actions::apply-response",
  set_consent: "adobe-alloy::actions::set-consent",
  update_variable: "adobe-alloy::actions::update-variable",
  send_media_event: "adobe-alloy::actions::send-media-event",
  evaluate_rulesets: "adobe-alloy::actions::evaluate-rulesets",
  redirect_with_identity: "adobe-alloy::actions::redirect-with-identity",
  reset_event_merge_id: "adobe-alloy::actions::reset-event-merge-id",
  // Data Elements
  variable: "adobe-alloy::dataElements::variable",
  identity_map: "adobe-alloy::dataElements::identity-map",
  xdm_object: "adobe-alloy::dataElements::xdm-object",
  event_merge_id: "adobe-alloy::dataElements::event-merge-id",
  qoe_details_data: "adobe-alloy::dataElements::qoe-details-data",
} as const;

// ── Web SDK extension settings ─────────────────────────────────────────
export interface WebSdkSettingsInput {
  datastreamId: string;
  orgId: string;
  /**
   * Raw CSS rule to prehide while Target loads. Default hides whole body
   * (legacy v1.0 behavior). Best practice is to scope to specific
   * containers — use `flickerSelectors` instead.
   */
  flickerStyle?: string;
  /**
   * v1.1 — preferred way to scope prehiding. Array of CSS selectors that
   * will be hidden until Target responds (or a 3s fallback fires).
   * If provided, takes precedence over `flickerStyle`.
   * Example: `["#hero", ".product-card", ".checkout-cta"]`
   */
  flickerSelectors?: string[];
  idMigrationEnabled?: boolean;
  targetMigrationEnabled?: boolean;
  defaultConsent?: "in" | "pending";
  thirdPartyCookies?: boolean;
  edgeDomain?: string;
}

/**
 * Build the prehiding CSS from either a literal style string or an
 * array of selectors. When selectors are supplied, the generated rule
 * scopes opacity:0 only to those selectors (not the whole body) — the
 * best-practice consultant approach.
 *
 * Includes a 3-second max-wait safety: prehiding never persists beyond
 * 3 seconds even if Target times out. Prevents the "blank page forever"
 * failure mode when Edge is unreachable.
 */
export function buildFlickerStyle(input: {
  flickerStyle?: string;
  flickerSelectors?: string[];
}): string {
  if (input.flickerSelectors && input.flickerSelectors.length > 0) {
    return `${input.flickerSelectors.join(", ")} { opacity: 0 !important }`;
  }
  return input.flickerStyle ?? "body { opacity: 0 !important }";
}

/**
 * Returns the Web SDK (alloy) extension settings as a JSON-encoded string,
 * ready to drop into `attributes.settings`.
 *
 * Schema confirmed live against Reactor 2026-06-13:
 *   {
 *     "instances": [{
 *       "name": "alloy",
 *       "edgeConfigId": "<datastreamId>",     ← renamed; not "datastreamId"
 *       "orgId": "<orgId>",
 *       "context": ["web", "device", ...],
 *       ...
 *     }]
 *   }
 *
 * Alloy supports multiple "instances" on one page (separate SDK contexts).
 * We default to a single instance named "alloy". Anything not in the
 * instance's allowed property set fails schema validation with
 * "of type object did not match any of the required schemas".
 */
export function websdkExtensionSettings(input: WebSdkSettingsInput): string {
  const instance: Record<string, unknown> = {
    name: "alloy",
    edgeConfigId: input.datastreamId,
    orgId: input.orgId,
    edgeDomain: input.edgeDomain ?? "edge.adobedc.net",
    edgeBasePath: "ee",
    defaultConsent: input.defaultConsent ?? "in",
    idMigrationEnabled: input.idMigrationEnabled ?? false,
    targetMigrationEnabled: input.targetMigrationEnabled ?? false,
    thirdPartyCookiesEnabled: input.thirdPartyCookies ?? false,
    prehidingStyle: buildFlickerStyle(input),
    context: ["web", "device", "environment", "placeContext"],
    clickCollectionEnabled: true,
    downloadLinkQualifier:
      "\\.(exe|zip|wav|mp3|mov|mpg|avi|wmv|pdf|doc|docx|xls|xlsx|ppt|pptx)$",
  };
  return JSON.stringify({ instances: [instance] });
}

// ── Data element settings builders (return JSON strings) ───────────────
export function deJsVariableSettings(path: string): string {
  return JSON.stringify({ path });
}

export function deCustomCodeSettings(source: string): string {
  // The core::dataElements::custom-code schema accepts only `source`.
  // Adding `language: "javascript"` (which the spec suggested) is rejected
  // with "contains an additional property 'language' outside of the schema".
  // Confirmed live 2026-06-13.
  return JSON.stringify({ source });
}

export function deIdentityMapSettings(
  crmIdDeName: string,
  _authStateDeName: string
): string {
  // Reactor schema for adobe-alloy::dataElements::identity-map:
  //   { "<NAMESPACE>": [{ id, primary, authenticatedState }] } at top level
  //   with additionalProperties = array-of-identity-entries.
  // NO `cacheLifetime` / `storageDuration` / `identityMap` wrapper (the
  // spec form fails validation as "0 is not an array").
  //
  // `authenticatedState` enum is strict ("loggedOut"|"authenticated"|"ambiguous"),
  // so a `%User - Auth State%` template doesn't pass schema validation.
  // Omit it — Tags will infer ambiguous at runtime when missing.
  return JSON.stringify({
    CRMID: [
      {
        id: `%${crmIdDeName}%`,
        primary: false,
      },
    ],
  });
}

// ── Per-data-element source-code blocks ────────────────────────────────
export const DE_USER_AUTH_STATE_SRC = `
var authState = "unknown";
try {
  if (typeof digitalData !== "undefined" &&
      digitalData.user && digitalData.user[0] &&
      digitalData.user[0].profile && digitalData.user[0].profile[0]) {
    var profileID = digitalData.user[0].profile[0].profileInfo &&
                    digitalData.user[0].profile[0].profileInfo.profileID;
    authState = profileID ? "authenticated" : "loggedOut";
  }
} catch(e) {}
return authState;
`.trim();

export const DE_XDM_PAGE_VIEW_SRC = `
return {
  eventType: "web.webpagedetails.pageViews",
  web: {
    webPageDetails: {
      name: _satellite.getVar("Page - Name") || document.title,
      URL: window.location.href
    },
    webReferrer: {
      URL: document.referrer || ""
    }
  },
  device: {
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    screenOrientation: window.screen.width > window.screen.height ? "landscape" : "portrait"
  },
  environment: {
    type: "browser",
    browserDetails: {
      userAgent: navigator.userAgent,
      acceptLanguage: navigator.language || navigator.userLanguage || "",
      javaScriptEnabled: true
    }
  },
  placeContext: {
    localTime: new Date().toISOString(),
    localTimezoneOffset: new Date().getTimezoneOffset()
  }
};
`.trim();

export const DE_TARGET_PROFILE_ATTRS_SRC = `
var attrs = {};
try {
  if (typeof digitalData !== "undefined" && digitalData.user && digitalData.user[0]) {
    var profile = digitalData.user[0].profile && digitalData.user[0].profile[0];
    if (profile) {
      var info = profile.profileInfo || {};
      if (info.loyaltyStatus) attrs.loyaltyStatus = info.loyaltyStatus;
      if (info.segment)       attrs.customerSegment = info.segment;
      if (info.loyaltyTier)   attrs.loyaltyTier = info.loyaltyTier;
    }
  }
} catch(e) {}
return attrs;
`.trim();

export const DE_ENVIRONMENT_NAME_SRC = `
var host = window.location.hostname.toLowerCase();
if (host === "localhost" || host.indexOf("dev.") === 0 || host.indexOf("-dev.") > -1) {
  return "development";
}
if (host.indexOf("staging.") === 0 || host.indexOf("-staging.") > -1 ||
    host.indexOf(".qa.") > -1 || host.indexOf("-qa.") > -1) {
  return "staging";
}
return "production";
`.trim();

export const DE_ORDER_PRODUCTS_SRC = `
try {
  var items = digitalData.transaction && digitalData.transaction.item;
  if (Array.isArray(items) && items.length > 0) {
    return items.map(function(item) {
      return (item.productInfo && item.productInfo.sku) || "";
    }).filter(Boolean).join(",");
  }
} catch(e) {}
return "";
`.trim();

// ── PAGE TYPE — URL + DOM heuristic ────────────────────────────────────
// Single most-targeted-against attribute in real Target audiences.
// Without a stable Page-Type DE, audience authors do brittle URL regex.
//
// Detection order:
//   1. <body data-page-type="..."> attribute — explicit author override
//   2. URL path heuristics for the common page types
//   3. Fallback: "generic"
export const DE_PAGE_TYPE_SRC = `
try {
  var explicit = document.body && document.body.getAttribute("data-page-type");
  if (explicit) return explicit;
  var path = (window.location.pathname || "").toLowerCase();
  if (path === "/" || path === "") return "home";
  if (path.indexOf("/order-confirmation") === 0) return "order-confirm";
  if (path.indexOf("/checkout") === 0) return "checkout";
  if (path.indexOf("/cart") === 0) return "cart";
  if (/\\/(product|p)\\//.test(path)) return "pdp";
  if (/\\/(category|c|shop|collection)\\//.test(path)) return "category";
  if (path.indexOf("/search") === 0 || /[?&]q=/.test(window.location.search)) return "search";
  if (path.indexOf("/account") === 0 || path.indexOf("/profile") === 0) return "account";
  if (path.indexOf("/blog") === 0 || path.indexOf("/article") === 0) return "article";
} catch(e) {}
return "generic";
`.trim();

// ── TARGET SEND EVENT DATA — the data.__adobe.target wrapper ──────────
// Reactor's Send Event schema requires `data` to be a string %DE name%
// reference, not a literal object. This wrapper DE returns the full
// {__adobe:{target:{profile, mbox3rdPartyId, ...}}} object so that
// profile params and mbox parameters actually reach Target.
//
// Without this wrapper, profile-based audience targeting silently
// doesn't work — Target receives the event with no profile attributes.
export const DE_TARGET_SEND_EVENT_DATA_SRC = `
return {
  __adobe: {
    target: {
      profile: _satellite.getVar("Target - Profile Attributes") || {},
      mbox3rdPartyId: _satellite.getVar("Target - mbox3rdPartyId") || ""
    }
  }
};
`.trim();

// ── Standard data-element catalog ──────────────────────────────────────
/**
 * Description of a single standard data element to create.
 * `extension` is the package name; the caller resolves it to the installed
 * extension's ID at runtime.
 */
export type DECategory =
  | "pageContext"
  | "identity"
  | "targetProfile"
  | "xdm"
  | "environment"
  | "orderTracking";

export interface StandardDataElement {
  name: string;
  delegateDescriptorId: string;
  extension: "core" | "alloy";
  /** JSON-encoded string ready for `attributes.settings`. */
  settings: string;
  storageDuration: "pageview" | "session" | "visitor";
  defaultValue?: string;
  /** v1.3 — which DE family this belongs to, for selection filtering. */
  category: DECategory;
  /**
   * @deprecated v1.3 — use category === "orderTracking" instead.
   * Still set for backward compat with any external callers.
   */
  orderOnly?: boolean;
}

// ── Selectable DE categories (v1.3) ────────────────────────────────────
//
// Senior consultants want to pick which DE families their site needs.
// Default: everything except order tracking on (matches the consultant-
// grade baseline). Order tracking is opt-in because not every site is
// ecommerce. Categories compose flat:
//
//   pageContext     → Page - Name, Page - URL, Page - Referrer, Page - Type
//   identity        → User - Auth State, User - CRM ID, XDM - Identity Map
//   targetProfile   → Target - Profile Attributes, Target - mbox3rdPartyId,
//                     Target - Send Event Data
//   xdm             → XDM - Page View
//   environment     → Environment - Name
//   orderTracking   → Order - ID, Order - Total, Order - Products
//
// Per-item overrides take precedence over categories (e.g. skip Page
// Referrer while keeping the rest of pageContext on).
export interface DataElementSelection {
  /** Defaults: all true except orderTracking. */
  pageContext?: boolean;
  identity?: boolean;
  targetProfile?: boolean;
  xdm?: boolean;
  environment?: boolean;
  orderTracking?: boolean;
  /** Force-include or force-exclude individual DE by name. */
  overrides?: Record<string, boolean>;
}

export interface StandardDeInput {
  pageNamePath: string;
  crmIdPath: string;
  orderIdPath?: string;
  orderTotalPath?: string;
  /**
   * @deprecated v1.3 — use selection.orderTracking instead. Still
   * honored for backward compatibility.
   */
  includeOrderDes?: boolean;
  /** v1.3 selection map. */
  selection?: DataElementSelection;
}

/**
 * Build the canonical list of data elements for a Target WebSDK property.
 * Order matters: DEs that reference others (e.g. XDM uses Page - Name)
 * are listed after their dependencies.
 */
export function standardDataElements(
  input: StandardDeInput
): StandardDataElement[] {
  // Selection: categories default-on except orderTracking.
  // Legacy `includeOrderDes: true` is honored as orderTracking opt-in.
  const sel = input.selection ?? {};
  const orderTrackingOn =
    sel.orderTracking ?? input.includeOrderDes ?? false;
  const enabled: Record<DECategory, boolean> = {
    pageContext: sel.pageContext ?? true,
    identity: sel.identity ?? true,
    targetProfile: sel.targetProfile ?? true,
    xdm: sel.xdm ?? true,
    environment: sel.environment ?? true,
    orderTracking: orderTrackingOn,
  };
  const overrides = sel.overrides ?? {};

  // Full catalog with category tags. Order matters: DEs that reference
  // others by %name% must follow their dependencies in this array.
  const catalog: StandardDataElement[] = [
    {
      name: "Page - Name",
      delegateDescriptorId: CORE_DESCRIPTORS.js_variable,
      extension: "core",
      settings: deJsVariableSettings(input.pageNamePath),
      storageDuration: "pageview",
      defaultValue: "unknown",
      category: "pageContext",
    },
    {
      name: "Page - URL",
      delegateDescriptorId: CORE_DESCRIPTORS.js_variable,
      extension: "core",
      settings: deJsVariableSettings("window.location.href"),
      storageDuration: "pageview",
      category: "pageContext",
    },
    {
      name: "Page - Referrer",
      delegateDescriptorId: CORE_DESCRIPTORS.js_variable,
      extension: "core",
      settings: deJsVariableSettings("document.referrer"),
      storageDuration: "pageview",
      defaultValue: "",
      category: "pageContext",
    },
    {
      name: "User - Auth State",
      delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
      extension: "core",
      settings: deCustomCodeSettings(DE_USER_AUTH_STATE_SRC),
      storageDuration: "session",
      category: "identity",
    },
    {
      name: "User - CRM ID",
      delegateDescriptorId: CORE_DESCRIPTORS.js_variable,
      extension: "core",
      settings: deJsVariableSettings(input.crmIdPath),
      storageDuration: "visitor",
      category: "identity",
    },
    {
      name: "XDM - Page View",
      delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
      extension: "core",
      settings: deCustomCodeSettings(DE_XDM_PAGE_VIEW_SRC),
      storageDuration: "pageview",
      category: "xdm",
    },
    {
      name: "XDM - Identity Map",
      delegateDescriptorId: ALLOY_DESCRIPTORS.identity_map,
      extension: "alloy",
      settings: deIdentityMapSettings("User - CRM ID", "User - Auth State"),
      storageDuration: "visitor",
      category: "identity",
    },
    {
      name: "Target - Profile Attributes",
      delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
      extension: "core",
      settings: deCustomCodeSettings(DE_TARGET_PROFILE_ATTRS_SRC),
      storageDuration: "pageview",
      category: "targetProfile",
    },
    {
      name: "Target - mbox3rdPartyId",
      delegateDescriptorId: CORE_DESCRIPTORS.js_variable,
      extension: "core",
      settings: deJsVariableSettings(input.crmIdPath),
      storageDuration: "visitor",
      defaultValue: "",
      category: "targetProfile",
    },
    {
      name: "Environment - Name",
      delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
      extension: "core",
      settings: deCustomCodeSettings(DE_ENVIRONMENT_NAME_SRC),
      storageDuration: "pageview",
      category: "environment",
    },
    {
      name: "Page - Type",
      delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
      extension: "core",
      settings: deCustomCodeSettings(DE_PAGE_TYPE_SRC),
      storageDuration: "pageview",
      defaultValue: "generic",
      category: "pageContext",
    },
    {
      // The wrapper DE the Send Event action references in its `data`
      // field. Without it, profile attributes silently don't reach Target.
      name: "Target - Send Event Data",
      delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
      extension: "core",
      settings: deCustomCodeSettings(DE_TARGET_SEND_EVENT_DATA_SRC),
      storageDuration: "pageview",
      category: "targetProfile",
    },
    {
      name: "Order - ID",
      delegateDescriptorId: CORE_DESCRIPTORS.js_variable,
      extension: "core",
      settings: deJsVariableSettings(
        input.orderIdPath ?? "digitalData.transaction.transactionID"
      ),
      storageDuration: "pageview",
      category: "orderTracking",
      orderOnly: true,
    },
    {
      name: "Order - Total",
      delegateDescriptorId: CORE_DESCRIPTORS.js_variable,
      extension: "core",
      settings: deJsVariableSettings(
        input.orderTotalPath ?? "digitalData.transaction.total.basePrice"
      ),
      storageDuration: "pageview",
      category: "orderTracking",
      orderOnly: true,
    },
    {
      name: "Order - Products",
      delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
      extension: "core",
      settings: deCustomCodeSettings(DE_ORDER_PRODUCTS_SRC),
      storageDuration: "pageview",
      category: "orderTracking",
      orderOnly: true,
    },
  ];

  // Filter: category enables baseline; per-item override wins both ways.
  return catalog.filter((de) => {
    const override = overrides[de.name];
    if (override === true) return true;
    if (override === false) return false;
    return enabled[de.category];
  });
}

// ── Rule component settings builders ───────────────────────────────────
export function rcDomReadySettings(): string {
  return JSON.stringify({});
}

/**
 * Library Loaded (Page Top) event — best-practice trigger for the
 * Target page-load rule.
 *
 * Why over DOM Ready: Library Loaded fires the instant the Tags
 * library finishes initializing — typically several hundred ms before
 * DOM Ready. That gives Target the head start it needs to fetch
 * decisions and apply propositions BEFORE the browser starts rendering
 * the personalized regions of the page. Result: significantly less
 * flicker on personalized content.
 *
 * Schema confirmed live against core 3.4.4 (2026-06): empty settings.
 * The "Page Top" placement is implicit — Library Loaded fires from
 * whatever position in the HTML the consultant pastes the Tags embed
 * script (best practice: top of <head>, before any other marketing
 * tags).
 */
export function rcLibraryLoadedSettings(): string {
  return JSON.stringify({});
}

/**
 * Guided Events mode for Send Event — the consultant-grade default.
 *
 * Adobe's Tags UI exposes "Use guided events" with two named modes:
 *   - "Request personalization" — fetches the latest Target decisions
 *     WITHOUT recording an Analytics event. Right call for page-load
 *     where you want personalization but don't want to double-count a
 *     page view (your Analytics extension is handling that separately).
 *   - "Collect analytics" — records an event WITHOUT requesting
 *     personalization. Right call for downstream events (PDP view,
 *     add-to-cart) where you've already personalized at page-load and
 *     are just recording user actions.
 *
 * Schema fields (confirmed against adobe-alloy 2.37.0):
 *   - guidedEventsEnabled: boolean
 *   - guidedEvent: string — "personalizationRequest" or "analyticsRequest"
 *   - type: omitted; Adobe derives the right XDM eventType from the
 *     guided mode internally
 *   - xdm + data: still passed through as %DE name% refs
 *   - renderDecisions: kept; consumed by "personalizationRequest" mode
 */
export type GuidedEventMode = "personalizationRequest" | "analyticsRequest";

export function rcGuidedSendEventSettings(opts: {
  xdmDeName: string;
  mode: GuidedEventMode;
  dataDeName?: string;
  renderDecisions?: boolean;
}): string {
  const settings: Record<string, unknown> = {
    instanceName: "alloy",
    guidedEventsEnabled: true,
    guidedEvent: opts.mode,
    xdm: `%${opts.xdmDeName}%`,
    renderDecisions: opts.renderDecisions ?? opts.mode === "personalizationRequest",
    documentUnloading: false,
  };
  if (opts.dataDeName) settings.data = `%${opts.dataDeName}%`;
  return JSON.stringify(settings);
}

export function rcSendEventSettings(
  xdmDeName: string,
  _profileDeName: string,
  _mbox3pIdDeName: string,
  renderDecisions: boolean,
  dataDeName?: string
): string {
  // Send Event schema (adobe-alloy::actions::send-event) — confirmed live
  // 2026-06:
  //   • instanceName: REQUIRED (the alloy instance name, defaults to "alloy")
  //   • xdm: MUST be a string matching ^%[^%]+%$ (a %DE name% ref)
  //   • data: MUST also be ^%[^%]+%$ if present; can't be a literal object.
  //     v1.1 wires `Target - Send Event Data` here (a custom-code DE that
  //     returns the {__adobe:{target:{profile, mbox3rdPartyId}}} payload)
  //     so profile-based audience targeting actually reaches Target.
  //   • mergeid → mergeId (capital I); must be ≥1 char when present, omit
  //     entirely if empty.
  const settings: Record<string, unknown> = {
    instanceName: "alloy",
    type: "web.webpagedetails.pageViews",
    xdm: `%${xdmDeName}%`,
    renderDecisions,
    documentUnloading: false,
  };
  if (dataDeName) settings.data = `%${dataDeName}%`;
  return JSON.stringify(settings);
}

export function rcSendPurchaseSettings(
  _orderIdDe: string,
  _orderTotalDe: string,
  _orderProductsDe: string
): string {
  // Purchase event — same schema constraints as page-view Send Event.
  // xdm and data must be %DE name% references. For a proper purchase rule,
  // the caller should build a "XDM - Purchase" custom-code DE that returns
  // the full commerce.purchases object and pass its name here. For now we
  // emit a minimal event that satisfies schema; consultants enhance as
  // needed.
  return JSON.stringify({
    instanceName: "alloy",
    type: "commerce.purchases",
    xdm: "%XDM - Page View%",
    renderDecisions: false,
    documentUnloading: false,
  });
}

export function rcPathConditionSettings(
  path: string,
  isRegex = false
): string {
  return JSON.stringify({
    paths: [{ value: path, valueIsRegex: isRegex }],
  });
}

// ── Conditions menu — pre-defined common conditions for page-load rule ──
//
// The v1.3 conditions menu lets consultants gate the page-load rule on
// common predicates without learning Reactor descriptor IDs by heart.
// Each kind maps to one core::conditions::* descriptor with a settings
// shape validated against the core 3.4.4 schemas.
//
// Schemas confirmed live:
//   url-matches            → core::conditions::path-and-querystring
//   path-only              → core::conditions::path  (NO query string)
//   cookie-equals          → core::conditions::cookie
//   domain-matches         → core::conditions::domain
//   subdomain-matches      → core::conditions::subdomain
//   data-element-equals    → core::conditions::value-comparison
//   raw                    → escape hatch for any descriptor + settings

export type PageLoadCondition =
  | {
      kind: "url-matches";
      /** One or more URL paths (path + querystring). */
      paths: Array<{ value: string; isRegex?: boolean }>;
      /** Set true to NEGATE — fires when none of the paths match. */
      negate?: boolean;
    }
  | {
      kind: "path-only";
      /** Path only (no querystring). */
      paths: Array<{ value: string; isRegex?: boolean }>;
      negate?: boolean;
    }
  | {
      kind: "cookie-equals";
      /** Cookie name (must match RFC 6265 token chars). */
      name: string;
      /** Acceptable values (OR'd). */
      values: Array<{ value: string; isRegex?: boolean }>;
      negate?: boolean;
    }
  | {
      kind: "domain-matches";
      domains: string[];
      negate?: boolean;
    }
  | {
      kind: "subdomain-matches";
      subdomains: string[];
      negate?: boolean;
    }
  | {
      kind: "data-element-equals";
      /** Data element name (referenced via %name% — fetched at runtime). */
      dataElementName: string;
      /** Expected value (string match). */
      expectedValue: string;
      caseInsensitive?: boolean;
      negate?: boolean;
    }
  | {
      kind: "raw";
      /** Escape hatch — pass any descriptor + raw settings object. */
      delegateDescriptorId: string;
      settings: Record<string, unknown>;
      name?: string;
      negate?: boolean;
    };

export interface BuiltCondition {
  delegateDescriptorId: string;
  settings: string; // JSON-encoded
  name: string;
  negate: boolean;
}

/**
 * Compiles a PageLoadCondition spec into the descriptor + settings
 * + display-name that the rule_components POST needs.
 */
export function buildCondition(spec: PageLoadCondition): BuiltCondition {
  switch (spec.kind) {
    case "url-matches":
      return {
        delegateDescriptorId: "core::conditions::path-and-querystring",
        settings: JSON.stringify({
          paths: spec.paths.map((p) => ({
            value: p.value,
            valueIsRegex: !!p.isRegex,
          })),
        }),
        name: `URL ${spec.negate ? "does not match" : "matches"}: ${spec.paths.map((p) => p.value).join(", ")}`,
        negate: !!spec.negate,
      };
    case "path-only":
      return {
        delegateDescriptorId: "core::conditions::path",
        settings: JSON.stringify({
          paths: spec.paths.map((p) => ({
            value: p.value,
            valueIsRegex: !!p.isRegex,
          })),
        }),
        name: `Path ${spec.negate ? "does not match" : "matches"}: ${spec.paths.map((p) => p.value).join(", ")}`,
        negate: !!spec.negate,
      };
    case "cookie-equals":
      return {
        delegateDescriptorId: "core::conditions::cookie",
        settings: JSON.stringify({
          name: spec.name,
          cookieValues: spec.values.map((v) => ({
            value: v.value,
            valueIsRegex: !!v.isRegex,
          })),
        }),
        name: `Cookie '${spec.name}' ${spec.negate ? "is not" : "is"} one of [${spec.values.map((v) => v.value).join(", ")}]`,
        negate: !!spec.negate,
      };
    case "domain-matches":
      return {
        delegateDescriptorId: "core::conditions::domain",
        settings: JSON.stringify({ domains: spec.domains }),
        name: `Domain ${spec.negate ? "is not" : "is"} one of [${spec.domains.join(", ")}]`,
        negate: !!spec.negate,
      };
    case "subdomain-matches":
      return {
        delegateDescriptorId: "core::conditions::subdomain",
        settings: JSON.stringify({ subdomains: spec.subdomains }),
        name: `Subdomain ${spec.negate ? "is not" : "is"} one of [${spec.subdomains.join(", ")}]`,
        negate: !!spec.negate,
      };
    case "data-element-equals":
      // value-comparison schema:
      //   { leftOperand, comparison: {operator, caseInsensitive}, rightOperand }
      // For data-element-equals we put %DE name% on the left and the
      // expected value on the right.
      return {
        delegateDescriptorId: "core::conditions::value-comparison",
        settings: JSON.stringify({
          leftOperand: `%${spec.dataElementName}%`,
          comparison: {
            operator: spec.negate ? "doesNotEqual" : "equals",
            caseInsensitive: !!spec.caseInsensitive,
          },
          rightOperand: spec.expectedValue,
        }),
        name: `Data element '${spec.dataElementName}' ${spec.negate ? "≠" : "="} '${spec.expectedValue}'`,
        // value-comparison handles its own negation via the operator,
        // so the component's negate flag stays false.
        negate: false,
      };
    case "raw":
      return {
        delegateDescriptorId: spec.delegateDescriptorId,
        settings: JSON.stringify(spec.settings),
        name: spec.name ?? `Custom condition (${spec.delegateDescriptorId})`,
        negate: !!spec.negate,
      };
  }
}

export function rcCustomEventSettings(eventType: string): string {
  // core::events::custom-event schema uses `type` (the event name),
  // NOT `eventType`. Confirmed against core package 3.4.4 — 2026-06-22.
  // The spec had `eventType` because alloy's Send Event action uses that
  // field name on a different schema; easy to confuse the two.
  return JSON.stringify({
    type: eventType,
    bubbleFireIfChildFired: true,
  });
}

export function rcSpaSendEventSettings(_pageNameDeName: string): string {
  // SPA view-change event — same schema. Send a minimal page-view re-fire
  // referencing the standard XDM DE; consultants extend with a dedicated
  // SPA-view XDM DE for richer data.
  return JSON.stringify({
    instanceName: "alloy",
    type: "web.webpagedetails.pageViews",
    xdm: "%XDM - Page View%",
    renderDecisions: true,
    documentUnloading: false,
  });
}

// ── Datastream service bodies ──────────────────────────────────────────
export interface TargetServiceInput {
  clientCode: string;
  propertyToken?: string | null;
  environment?: "production" | "staging" | "development";
  timeout?: number;
  a4tEnabled?: boolean;
}

export function targetServiceBody(input: TargetServiceInput): {
  type: string;
  enabled: boolean;
  settings: Record<string, unknown>;
} {
  return {
    type: "Target",
    enabled: true,
    settings: {
      clientCode: input.clientCode,
      propertyToken: input.propertyToken ?? null,
      targetEnvironment: input.environment ?? "production",
      environmentId: null,
      timeout: input.timeout ?? 5000,
      a4tEnabled: input.a4tEnabled ?? false,
    },
  };
}

export interface AnalyticsServiceInput {
  reportSuites: string[];
  trackingServer: string;
  sslTrackingServer?: string;
}

export function analyticsServiceBody(input: AnalyticsServiceInput): {
  type: string;
  enabled: boolean;
  settings: Record<string, unknown>;
} {
  return {
    type: "Analytics",
    enabled: true,
    settings: {
      reportSuites: input.reportSuites,
      server: input.trackingServer,
      sslServer: input.sslTrackingServer ?? input.trackingServer,
    },
  };
}

// ── Edge Network test payload ──────────────────────────────────────────
export interface EdgeTestPayload {
  payload: Record<string, unknown>;
  requestId: string;
  testEcid: string;
}

/**
 * Build a synthetic page-view event for `test_edge_network`. The ECID
 * is a random 18-digit string; Edge accepts arbitrary opaque ECIDs from
 * unauthenticated client traffic. No auth headers required when this is
 * POSTed to edge.adobedc.net.
 */
export function buildEdgeTestPayload(
  pageName = "MCP Validation Test",
  pageUrl = "https://mcp-validation.local"
): EdgeTestPayload {
  let testEcid = "";
  for (let i = 0; i < 18; i++) {
    testEcid += Math.floor(Math.random() * 10).toString();
  }
  const requestId = randomUUID();
  const eventId = randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");

  // Adobe Edge Network v2 /interact payload shape — confirmed end-to-end
  // 2026-06-13 against agsinternal sandbox prod.
  //
  // Iteration history (each fixed a specific Edge rejection):
  //   1. `events: [...]` → rejected EXEG-0103-400 "event field is mandatory"
  //      Fix: use `event: {...}` (singular).
  //   2. Synthetic 18-digit ECID → rejected EXEG-0305-400 "Invalid identity"
  //      Fix: omit ECID; Edge mints one when `query.identity.fetch` is set.
  //   3. Returned 200 but no identity / no Target handle
  //      Fix: include `query` block to ASK for identity fetch + Target
  //      personalization decisions. Without it, Edge only acknowledges the
  //      event (locationHint + state:store) without running anything.
  const payload = {
    event: {
      xdm: {
        _id: eventId,
        timestamp,
        eventType: "web.webpagedetails.pageViews",
        web: {
          webPageDetails: { name: pageName, URL: pageUrl },
          webReferrer: { URL: "" },
        },
        device: { screenWidth: 1920, screenHeight: 1080 },
        environment: {
          type: "browser",
          browserDetails: {
            userAgent: "Mozilla/5.0 (MCP-Validator/1.0)",
          },
        },
      },
    },
    query: {
      identity: { fetch: ["ECID"] },
      personalization: {
        schemas: [
          "https://ns.adobe.com/personalization/default-content-item",
          "https://ns.adobe.com/personalization/html-content-item",
          "https://ns.adobe.com/personalization/json-content-item",
          "https://ns.adobe.com/personalization/redirect-item",
          "https://ns.adobe.com/personalization/dom-action",
        ],
        decisionScopes: ["__view__"],
      },
    },
  };

  return { payload, requestId, testEcid };
}

// ── Website HTML scanning patterns ─────────────────────────────────────
export interface WebsiteImplChecks {
  tagsEmbedPresent: boolean;
  foundTagsUrl: string | null;
  correctScriptUrl: boolean | null;
  scriptIsAsync: boolean;
  atjsConflictDetected: boolean;
  mcidConflictDetected: boolean;
  acdlPresent: boolean;
  alloyDirectInclude: boolean;
}

const TAGS_PATTERN = /src=["']\/\/assets\.adobedtm\.com\/[^"']+\.js["']/;
const SCRIPT_BLOCK_PATTERN = /<script[^>]*assets\.adobedtm\.com[^>]*>/i;
const ATJS_PATTERNS = [
  /cdn\.tt\.omtrdc\.net[^"']*at\.js/i,
  /["']at\.js["']/i,
  /mbox\.js/i,
  /adobe\.target\.init/i,
];
const MCID_PATTERNS = [/VisitorAPI\.js/i, /visitor\.js/i, /s\.Visitor\s*=/];

export function analyzeWebsiteHtml(
  html: string,
  expectedScriptUrl?: string | null
): WebsiteImplChecks {
  const tagsMatch = html.match(TAGS_PATTERN);
  const tagsEmbedPresent = !!tagsMatch;
  const foundTagsUrl = tagsMatch ? tagsMatch[0] : null;

  let correctScriptUrl: boolean | null = null;
  if (expectedScriptUrl && tagsEmbedPresent) {
    const stripped = expectedScriptUrl
      .replace(/^https?:/i, "")
      .replace(/^\/+/, "//");
    correctScriptUrl = html.includes(stripped);
  }

  let scriptIsAsync = false;
  if (tagsEmbedPresent) {
    const scriptTag = html.match(SCRIPT_BLOCK_PATTERN);
    scriptIsAsync = !!scriptTag && /\basync\b/i.test(scriptTag[0]);
  }

  const atjsConflictDetected = ATJS_PATTERNS.some((p) => p.test(html));
  const mcidConflictDetected = MCID_PATTERNS.some((p) => p.test(html));
  const acdlPresent = /(adobeDataLayer|window\.adobeDataLayer)/.test(html);
  const alloyDirectInclude = /(alloy\.min\.js|alloy\.js)/.test(html);

  return {
    tagsEmbedPresent,
    foundTagsUrl,
    correctScriptUrl,
    scriptIsAsync,
    atjsConflictDetected,
    mcidConflictDetected,
    acdlPresent,
    alloyDirectInclude,
  };
}

// ── Edge response parsing ──────────────────────────────────────────────
export interface ParsedEdgeResponse {
  edgeResponded: boolean;
  identityAssigned: boolean;
  ecidInResponse: boolean;
  targetResponding: boolean;
  targetActivityCount: number;
  targetScopesReturned: string[];
  viewScopePresent: boolean;
  locationHint: string | null;
  warnings: unknown[];
  errors: unknown[];
  rawHandleTypes: string[];
}

export function parseEdgeResponse(responseJson: unknown): ParsedEdgeResponse {
  const r = (responseJson ?? {}) as Record<string, unknown>;
  const handles: Record<string, unknown[]> = {};
  const handleArr = Array.isArray(r.handle) ? (r.handle as unknown[]) : [];
  for (const h of handleArr) {
    const obj = h as { type?: string; payload?: unknown[] };
    if (obj.type)
      handles[obj.type] = Array.isArray(obj.payload) ? obj.payload : [];
  }

  const targetDecisions = handles["personalization:decisions"] ?? [];
  const targetScopes = targetDecisions
    .map((d) => (d as { scope?: string }).scope ?? "")
    .filter(Boolean);

  const identityResult = handles["identity:result"] ?? [];
  const ecidInResponse = identityResult.some(
    (item) =>
      (item as { namespace?: { code?: string } })?.namespace?.code === "ECID"
  );

  const locationHintArr = handles["locationHint:result"] ?? [];
  const locationHint =
    locationHintArr.length > 0
      ? ((locationHintArr[0] as { hint?: string }).hint ?? null)
      : null;

  return {
    edgeResponded: true,
    identityAssigned: "identity:result" in handles,
    ecidInResponse,
    targetResponding: "personalization:decisions" in handles,
    targetActivityCount: targetDecisions.length,
    targetScopesReturned: targetScopes,
    viewScopePresent: targetScopes.includes("__view__"),
    locationHint,
    warnings: Array.isArray(r.warnings) ? (r.warnings as unknown[]) : [],
    errors: Array.isArray(r.errors) ? (r.errors as unknown[]) : [],
    rawHandleTypes: Object.keys(handles),
  };
}
