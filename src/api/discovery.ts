/**
 * Site discovery — static fingerprinting before setup_target_websdk.
 *
 * Fetches the page once via HTTP and sniffs the served HTML for:
 *   • existing Tags / alloy / at.js / DTM / GTM implementations
 *   • data layer flavor (CEDDL / ACDL / GTM dataLayer / none)
 *   • framework signals (React / Next.js / Vue / Angular / vanilla)
 *   • CMP vendor (OneTrust / Cookiebot / Adobe Consent / Iubenda / TrustArc / IAB TCF / none)
 *   • page-type heuristic for the URL
 *
 * Limitations (documented up-front; static fetch only by design):
 *   • Doesn't execute JavaScript. SPAs that inject the data layer via JS
 *     after first paint will look "empty" to this tool.
 *   • Doesn't render the page. CSS-driven hide/show isn't visible.
 *   • Only fetches the URL given — doesn't follow client-side routes.
 *
 * Chrome MCP integration (for SPA-aware discovery) is deferred to v1.2.
 */

export type DataLayerFlavor =
  | "acdl"
  | "ceddl"
  | "gtm"
  | "tealium"
  | "custom"
  | "none";

export type FrameworkHint =
  | "next"
  | "react"
  | "vue"
  | "angular"
  | "svelte"
  | "nuxt"
  | "remix"
  | "gatsby"
  | "vanilla"
  | "unknown";

export type CmpVendor =
  | "onetrust"
  | "cookiebot"
  | "adobe-consent"
  | "iubenda"
  | "trustarc"
  | "iab-tcf"
  | "didomi"
  | "usercentrics"
  | "quantcast"
  | "none";

export type PageType =
  | "home"
  | "pdp"
  | "category"
  | "cart"
  | "checkout"
  | "order-confirm"
  | "search"
  | "account"
  | "article"
  | "generic";

export interface DiscoveryReport {
  url: string;
  http_status: number;
  detected: {
    existing_implementation: {
      tags_embed_present: boolean;
      tags_script_url: string | null;
      alloy_direct_include: boolean;
      atjs_present: boolean;
      dtm_legacy_present: boolean;
      gtm_present: boolean;
    };
    data_layer_flavor: DataLayerFlavor;
    data_layer_evidence: string[];
    framework: FrameworkHint;
    framework_evidence: string[];
    cmp_vendor: CmpVendor;
    cmp_evidence: string[];
    page_type: PageType;
  };
  recommended_setup: {
    pageNamePath: string;
    crmIdPath: string;
    consentMode: "in" | "pending";
    notes: string[];
  };
  warnings: string[];
  summary: string;
}

const TAGS_PATTERN = /src=["']\/\/assets\.adobedtm\.com\/[^"']+\.js["']/;
const ALLOY_DIRECT_PATTERN = /(alloy\.min\.js|alloy\.js)/;
const ATJS_PATTERNS = [
  /cdn\.tt\.omtrdc\.net[^"']*at\.js/i,
  /["']at\.js["']/i,
  /mbox\.js/i,
  /adobe\.target\.init/i,
];
const DTM_LEGACY_PATTERN = /assets\.adobedtm\.com\/.*\.satelliteLib/i;
const GTM_PATTERN = /(googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+)/;

function detectDataLayer(html: string): {
  flavor: DataLayerFlavor;
  evidence: string[];
} {
  const evidence: string[] = [];
  const isAcdl = /\b(window\.)?adobeDataLayer\b/.test(html);
  const isCeddl = /\b(window\.)?digitalData\b/.test(html);
  const isGtm = /\b(window\.)?dataLayer\s*=/.test(html) || GTM_PATTERN.test(html);
  const isTealium = /\butag_data\b/.test(html);

  if (isAcdl) evidence.push("adobeDataLayer reference found");
  if (isCeddl) evidence.push("digitalData reference found (CEDDL)");
  if (isGtm) evidence.push("dataLayer / GTM reference found");
  if (isTealium) evidence.push("utag_data reference found (Tealium)");

  let flavor: DataLayerFlavor = "none";
  if (isAcdl) flavor = "acdl";
  else if (isCeddl) flavor = "ceddl";
  else if (isTealium) flavor = "tealium";
  else if (isGtm) flavor = "gtm";

  return { flavor, evidence };
}

function detectFramework(html: string): {
  hint: FrameworkHint;
  evidence: string[];
} {
  const evidence: string[] = [];

  if (/_next\/static|__NEXT_DATA__|<script[^>]+src="\/_next\//.test(html)) {
    evidence.push("Next.js shipping markers (_next/static or __NEXT_DATA__)");
    return { hint: "next", evidence };
  }
  if (/__NUXT__|<script[^>]+src="\/_nuxt\//.test(html)) {
    evidence.push("Nuxt markers (__NUXT__ or /_nuxt/)");
    return { hint: "nuxt", evidence };
  }
  if (/<!--\s*Built with Gatsby|___gatsby/.test(html)) {
    evidence.push("Gatsby markers");
    return { hint: "gatsby", evidence };
  }
  if (/__remixContext|<script[^>]+src="[^"]*remix-/.test(html)) {
    evidence.push("Remix markers");
    return { hint: "remix", evidence };
  }
  if (/data-reactroot|__REACT_DEVTOOLS|React\.createElement/.test(html)) {
    evidence.push("React markers");
    return { hint: "react", evidence };
  }
  if (/<[^>]+v-(?:if|for|bind|model|on|show)|__VUE__|new Vue\(/.test(html)) {
    evidence.push("Vue markers");
    return { hint: "vue", evidence };
  }
  if (/ng-app|ng-version|<[^>]+ng-(?:if|repeat|model)/.test(html)) {
    evidence.push("Angular markers");
    return { hint: "angular", evidence };
  }
  if (/<script[^>]+src="[^"]*svelte/.test(html)) {
    evidence.push("Svelte markers");
    return { hint: "svelte", evidence };
  }
  return { hint: "vanilla", evidence: ["No SPA framework markers found"] };
}

function detectCmp(html: string): { vendor: CmpVendor; evidence: string[] } {
  const checks: Array<[CmpVendor, RegExp, string]> = [
    ["onetrust", /(otSDKStub|OneTrust|optanon)/i, "OneTrust markers"],
    ["cookiebot", /Cookiebot|cookiebot\.com/i, "Cookiebot markers"],
    [
      "adobe-consent",
      /alloy\(["']set-?[Cc]onsent|adobe-consent/i,
      "Adobe Consent / alloy setConsent markers",
    ],
    ["iubenda", /iubenda/i, "Iubenda markers"],
    ["trustarc", /trustarc|truste\.com/i, "TrustArc markers"],
    ["didomi", /didomi/i, "Didomi markers"],
    ["usercentrics", /usercentrics/i, "Usercentrics markers"],
    ["quantcast", /quantcast\.mgr/i, "Quantcast markers"],
    ["iab-tcf", /__tcfapi|tcfapi/, "IAB TCF v2 API found"],
  ];
  for (const [vendor, pattern, label] of checks) {
    if (pattern.test(html)) return { vendor, evidence: [label] };
  }
  return { vendor: "none", evidence: ["No CMP markers detected"] };
}

function detectPageType(url: string, html: string): PageType {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = "";
  }
  const search = (() => {
    try {
      return new URL(url).search.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (path === "/" || path === "") return "home";
  if (path.startsWith("/order-confirmation") || path.startsWith("/thank-you"))
    return "order-confirm";
  if (path.startsWith("/checkout")) return "checkout";
  if (path.startsWith("/cart") || path.startsWith("/bag")) return "cart";
  if (/^\/(product|p)\//.test(path)) return "pdp";
  if (/^\/(category|c|shop|collection)\//.test(path)) return "category";
  if (path.startsWith("/search") || /[?&]q=/.test(search)) return "search";
  if (path.startsWith("/account") || path.startsWith("/profile"))
    return "account";
  if (path.startsWith("/blog") || path.startsWith("/article")) return "article";

  // DOM-attribute fallback
  const explicitMatch = /<body[^>]+data-page-type=["']([^"']+)["']/i.exec(html);
  if (explicitMatch) {
    const v = (explicitMatch[1] ?? "").toLowerCase();
    if (
      [
        "home",
        "pdp",
        "category",
        "cart",
        "checkout",
        "order-confirm",
        "search",
        "account",
        "article",
      ].includes(v)
    )
      return v as PageType;
  }

  // Heuristic price-tag presence → likely PDP
  if (
    /<[^>]+(?:itemprop="price"|data-price=|class="[^"]*price[^"]*")/i.test(html)
  ) {
    if (/add[\s-]?to[\s-]?cart|buy now/i.test(html)) return "pdp";
  }

  return "generic";
}

// ── Public API ──────────────────────────────────────────────
export async function discoverSite(
  url: string
): Promise<DiscoveryReport> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (target-websdk-foundation discover_site)" },
      redirect: "follow",
    });
  } catch (e) {
    return {
      url,
      http_status: 0,
      detected: {
        existing_implementation: {
          tags_embed_present: false,
          tags_script_url: null,
          alloy_direct_include: false,
          atjs_present: false,
          dtm_legacy_present: false,
          gtm_present: false,
        },
        data_layer_flavor: "none",
        data_layer_evidence: [],
        framework: "unknown",
        framework_evidence: [],
        cmp_vendor: "none",
        cmp_evidence: [],
        page_type: "generic",
      },
      recommended_setup: {
        pageNamePath: "digitalData.page.pageInfo.pageName",
        crmIdPath: "digitalData.user[0].profile[0].profileInfo.profileID",
        consentMode: "in",
        notes: [],
      },
      warnings: [`Could not fetch ${url}: ${(e as Error).message}`],
      summary: `Network error fetching ${url}.`,
    };
  }

  const html = await res.text();

  // Existing implementation sniffing
  const tagsMatch = html.match(TAGS_PATTERN);
  const existing = {
    tags_embed_present: !!tagsMatch,
    tags_script_url: tagsMatch ? tagsMatch[0].slice(5, -1) : null,
    alloy_direct_include: ALLOY_DIRECT_PATTERN.test(html),
    atjs_present: ATJS_PATTERNS.some((p) => p.test(html)),
    dtm_legacy_present: DTM_LEGACY_PATTERN.test(html),
    gtm_present: GTM_PATTERN.test(html),
  };

  const { flavor: dataLayerFlavor, evidence: dlEvidence } = detectDataLayer(html);
  const { hint: framework, evidence: fwEvidence } = detectFramework(html);
  const { vendor: cmpVendor, evidence: cmpEvidence } = detectCmp(html);
  const pageType = detectPageType(url, html);

  // Build recommended setup based on detection
  let pageNamePath = "digitalData.page.pageInfo.pageName";
  let crmIdPath = "digitalData.user[0].profile[0].profileInfo.profileID";
  const recNotes: string[] = [];

  if (dataLayerFlavor === "acdl") {
    pageNamePath = "adobeDataLayer.find(e => e.event === 'page-loaded').page.name";
    crmIdPath = "adobeDataLayer.find(e => e.event === 'user-loaded').user.profileID";
    recNotes.push(
      "ACDL data layer detected. The default DE paths assume CEDDL — override pageNamePath and crmIdPath to match your ACDL event/key shape. The ACDL Helper extension on Tags makes path lookups easier."
    );
  } else if (dataLayerFlavor === "gtm" || dataLayerFlavor === "tealium") {
    recNotes.push(
      `${dataLayerFlavor.toUpperCase()} data layer detected. Default DE paths assume Adobe CEDDL — you'll need to override pageNamePath and crmIdPath to match the actual data layer schema of this site.`
    );
  } else if (dataLayerFlavor === "none") {
    recNotes.push(
      "No data layer detected. The standard DEs will return 'unknown' / empty values, and Target activities targeting page name or user ID will not work correctly. Add a data layer to the site or override the paths."
    );
  }

  const consentMode: "in" | "pending" =
    cmpVendor !== "none" ? "pending" : "in";
  if (cmpVendor !== "none") {
    recNotes.push(
      `${cmpVendor} CMP detected. Use consentMode: "pending" in setup_target_websdk and wire the CMP's consent-grant event to a Set Consent rule. The MCP doesn't yet auto-generate the consent rule per vendor (v1.2).`
    );
  } else {
    recNotes.push(
      "No CMP detected. consentMode: 'in' is reasonable for non-EU sites. For EU/UK compliance, install a CMP and switch to consentMode: 'pending'."
    );
  }

  if (framework === "next" || framework === "react" || framework === "vue" || framework === "angular" || framework === "svelte" || framework === "nuxt" || framework === "remix" || framework === "gatsby") {
    recNotes.push(
      `${framework} SPA detected. The default page-load rule fires only on hard navigation; client-side route changes will NOT trigger Target. Pass includeSpaRule: true to create_standard_rules and dispatch a custom event from your router on each view change.`
    );
  }

  if (existing.atjs_present) {
    recNotes.push(
      "Legacy at.js detected on this page. To run Web SDK in parallel with at.js during migration, pass targetMigrationEnabled: true to install_websdk_extension AND set targetMigrationEnabled on the datastream."
    );
  }
  if (existing.dtm_legacy_present) {
    recNotes.push(
      "Legacy DTM (pre-Tags) detected. Removing DTM is the priority before installing Web SDK — they conflict."
    );
  }

  const warnings: string[] = [];
  if (!res.ok) {
    warnings.push(`HTTP ${res.status} — discovery ran against a non-2xx response; signals may be unreliable.`);
  }
  if (
    (framework === "react" || framework === "next" || framework === "vue" || framework === "angular" || framework === "svelte" || framework === "nuxt" || framework === "remix" || framework === "gatsby") &&
    dataLayerFlavor === "none"
  ) {
    warnings.push(
      "SPA framework detected but no data layer found in served HTML. The data layer may be JavaScript-injected after first paint — this static-fetch discovery can't see those. Capture a live network trace from the running site to confirm."
    );
  }

  const summary = [
    `Page type: ${pageType}.`,
    `Data layer: ${dataLayerFlavor}.`,
    `Framework: ${framework}.`,
    `CMP: ${cmpVendor}.`,
    existing.tags_embed_present
      ? "Tags embed already present — re-using or migrating an existing implementation."
      : "No Tags embed found — fresh implementation candidate.",
  ].join(" ");

  return {
    url,
    http_status: res.status,
    detected: {
      existing_implementation: existing,
      data_layer_flavor: dataLayerFlavor,
      data_layer_evidence: dlEvidence,
      framework,
      framework_evidence: fwEvidence,
      cmp_vendor: cmpVendor,
      cmp_evidence: cmpEvidence,
      page_type: pageType,
    },
    recommended_setup: {
      pageNamePath,
      crmIdPath,
      consentMode,
      notes: recNotes,
    },
    warnings,
    summary,
  };
}
