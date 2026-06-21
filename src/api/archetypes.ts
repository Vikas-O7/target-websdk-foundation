/**
 * Archetypes — opinionated, vertical-specific defaults that compose on top
 * of the standard catalog created by setup_target_websdk.
 *
 * Each archetype is idempotent: it skips DEs / rules / settings already
 * present on the property and creates only what's missing.
 *
 * v1.1 ships only `ecommerce_standard`. The other 3 archetypes
 * (b2b_lead_gen, media_publisher, saas_funnel) are deferred to v1.2
 * — building them right needs feedback from real consultants on the
 * first archetype before we generalize the framework.
 */

import {
  reactorRequest,
  reactorPaginate,
  ensureSettingsString,
  getId,
  type JsonApiSingleResponse,
} from "./reactor-client.js";
import {
  CORE_DESCRIPTORS,
  ALLOY_DESCRIPTORS,
  deCustomCodeSettings,
  deJsVariableSettings,
} from "./templates.js";

export type ArchetypeName = "ecommerce_standard";

export interface ApplyArchetypeInput {
  propertyId: string;
  archetype: ArchetypeName;
  /**
   * Custom data-layer paths for ecommerce-specific signals. Defaults match
   * the Adobe CEDDL spec but real sites often deviate — override here.
   */
  pdpProductSkuPath?: string;
  pdpProductNamePath?: string;
  pdpProductCategoryPath?: string;
  cartItemsPath?: string;
}

export interface ApplyArchetypeResult {
  archetype: ArchetypeName;
  data_elements_added: Array<{ name: string; id: string; status: "created" | "skipped" }>;
  rules_added: Array<{ name: string; id: string; status: "created" | "skipped"; components?: number }>;
  notes: string[];
  next_steps: string[];
}

// ── Ecommerce-standard DE source code ──────────────────────
const DE_PRODUCT_SKU_SRC = (path: string) => `
try {
  var sku = ${path};
  if (sku) return String(sku);
} catch(e) {}
try {
  var el = document.querySelector("[data-product-sku], [itemprop='sku']");
  if (el) return el.getAttribute("data-product-sku") || el.getAttribute("content") || el.textContent.trim();
} catch(e) {}
return "";
`.trim();

const DE_PRODUCT_NAME_SRC = (path: string) => `
try {
  var name = ${path};
  if (name) return String(name);
} catch(e) {}
try {
  var el = document.querySelector("[itemprop='name'], h1[data-product-name], h1.product-title");
  if (el) return (el.getAttribute("content") || el.textContent || "").trim();
} catch(e) {}
return "";
`.trim();

const DE_PRODUCT_CATEGORY_SRC = (path: string) => `
try {
  var cat = ${path};
  if (cat) return String(cat);
} catch(e) {}
try {
  var el = document.querySelector("[data-product-category]");
  if (el) return el.getAttribute("data-product-category") || "";
} catch(e) {}
return "";
`.trim();

const DE_CART_ITEMS_COUNT_SRC = (path: string) => `
try {
  var items = ${path};
  if (Array.isArray(items)) return items.length;
  if (typeof items === "number") return items;
} catch(e) {}
return 0;
`.trim();

// ── XDM payloads for ecommerce events ──────────────────────
const XDM_PRODUCT_VIEW_SRC = `
return {
  eventType: "commerce.productViews",
  commerce: {
    productViews: { value: 1 }
  },
  productListItems: [{
    SKU: _satellite.getVar("Product - SKU") || "",
    name: _satellite.getVar("Product - Name") || "",
    productCategory: _satellite.getVar("Product - Category") || ""
  }]
};
`.trim();

const XDM_ADD_TO_CART_SRC = `
return {
  eventType: "commerce.productListAdds",
  commerce: {
    productListAdds: { value: 1 }
  },
  productListItems: [{
    SKU: _satellite.getVar("Product - SKU") || "",
    name: _satellite.getVar("Product - Name") || ""
  }]
};
`.trim();

const XDM_CHECKOUT_START_SRC = `
return {
  eventType: "commerce.checkouts",
  commerce: {
    checkouts: { value: 1 }
  }
};
`.trim();

// ── Ecommerce-standard catalog ─────────────────────────────
interface ArchetypeDataElement {
  name: string;
  delegateDescriptorId: string;
  extension: "core" | "alloy";
  settingsBuilder: (input: ApplyArchetypeInput) => string;
  storageDuration: "pageview" | "session" | "visitor";
  defaultValue?: string;
}

const ECOMMERCE_DES: ArchetypeDataElement[] = [
  {
    name: "Product - SKU",
    delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
    extension: "core",
    settingsBuilder: (i) =>
      deCustomCodeSettings(
        DE_PRODUCT_SKU_SRC(
          i.pdpProductSkuPath ?? "digitalData.product[0].productInfo.sku"
        )
      ),
    storageDuration: "pageview",
  },
  {
    name: "Product - Name",
    delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
    extension: "core",
    settingsBuilder: (i) =>
      deCustomCodeSettings(
        DE_PRODUCT_NAME_SRC(
          i.pdpProductNamePath ?? "digitalData.product[0].productInfo.productName"
        )
      ),
    storageDuration: "pageview",
  },
  {
    name: "Product - Category",
    delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
    extension: "core",
    settingsBuilder: (i) =>
      deCustomCodeSettings(
        DE_PRODUCT_CATEGORY_SRC(
          i.pdpProductCategoryPath ??
            "digitalData.product[0].category.primaryCategory"
        )
      ),
    storageDuration: "pageview",
  },
  {
    name: "Cart - Item Count",
    delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
    extension: "core",
    settingsBuilder: (i) =>
      deCustomCodeSettings(
        DE_CART_ITEMS_COUNT_SRC(
          i.cartItemsPath ?? "digitalData.cart.item"
        )
      ),
    storageDuration: "pageview",
    defaultValue: "0",
  },
  {
    name: "XDM - Product View",
    delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
    extension: "core",
    settingsBuilder: () => deCustomCodeSettings(XDM_PRODUCT_VIEW_SRC),
    storageDuration: "pageview",
  },
  {
    name: "XDM - Add to Cart",
    delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
    extension: "core",
    settingsBuilder: () => deCustomCodeSettings(XDM_ADD_TO_CART_SRC),
    storageDuration: "pageview",
  },
  {
    name: "XDM - Checkout Start",
    delegateDescriptorId: CORE_DESCRIPTORS.custom_code_de,
    extension: "core",
    settingsBuilder: () => deCustomCodeSettings(XDM_CHECKOUT_START_SRC),
    storageDuration: "pageview",
  },
];

// ── Rules ──────────────────────────────────────────────────
interface ArchetypeRule {
  name: string;
  build: (
    propertyId: string,
    coreExtId: string,
    alloyExtId: string
  ) => Promise<{ ruleId: string; components: number }>;
}

function rcPathConditionSettings(path: string, isRegex = false): string {
  return JSON.stringify({
    paths: [{ value: path, valueIsRegex: isRegex }],
  });
}

function rcSendEventArchetypeSettings(xdmDeName: string): string {
  return JSON.stringify({
    instanceName: "alloy",
    type: "web.webpagedetails.pageViews",
    xdm: `%${xdmDeName}%`,
    data: "%Target - Send Event Data%",
    renderDecisions: true,
    documentUnloading: false,
  });
}

function rcCustomEventSettings(eventType: string): string {
  return JSON.stringify({
    eventType,
    bubbleFireIfChildFired: true,
  });
}

async function createRuleWithComponents(
  propertyId: string,
  ruleName: string,
  components: Array<{
    extensionId: string;
    delegateDescriptorId: string;
    settings: string;
    name: string;
    order?: number;
    timeout?: number;
  }>
): Promise<{ ruleId: string; components: number }> {
  const ruleBody = {
    data: {
      type: "rules",
      attributes: { name: ruleName, enabled: true },
    },
  };
  const ruleResp = await reactorRequest<JsonApiSingleResponse>(
    `/properties/${propertyId}/rules`,
    { method: "POST", body: ruleBody }
  );
  const ruleId = getId(ruleResp);

  for (const c of components) {
    const attrs: Record<string, unknown> = {
      delegate_descriptor_id: c.delegateDescriptorId,
      name: c.name,
      order: c.order ?? 0,
      rule_order: 50,
      settings: ensureSettingsString(c.settings),
      negate: false,
    };
    if (c.timeout !== undefined) attrs.timeout = c.timeout;
    await reactorRequest(`/properties/${propertyId}/rule_components`, {
      method: "POST",
      body: {
        data: {
          type: "rule_components",
          attributes: attrs,
          relationships: {
            extension: {
              data: { id: c.extensionId, type: "extensions" },
            },
            rules: {
              data: [{ id: ruleId, type: "rules" }],
            },
          },
        },
      },
    });
  }
  return { ruleId, components: components.length };
}

function ecommerceRules(): ArchetypeRule[] {
  return [
    {
      name: "PDP - Target WebSDK - Product View",
      build: async (propertyId, coreExtId, alloyExtId) =>
        createRuleWithComponents(propertyId, "PDP - Target WebSDK - Product View", [
          {
            extensionId: coreExtId,
            delegateDescriptorId: CORE_DESCRIPTORS.dom_ready,
            settings: JSON.stringify({}),
            name: "DOM Ready",
            timeout: 2000,
          },
          {
            extensionId: coreExtId,
            delegateDescriptorId: CORE_DESCRIPTORS.path_condition,
            settings: rcPathConditionSettings("/product/.*", true),
            name: "Path matches PDP",
          },
          {
            extensionId: alloyExtId,
            delegateDescriptorId: ALLOY_DESCRIPTORS.send_event,
            settings: rcSendEventArchetypeSettings("XDM - Product View"),
            name: "Send Product View",
          },
        ]),
    },
    {
      name: "Cart - Target WebSDK - Add to Cart",
      build: async (propertyId, coreExtId, alloyExtId) =>
        createRuleWithComponents(propertyId, "Cart - Target WebSDK - Add to Cart", [
          {
            // Custom event the site must dispatch when add-to-cart succeeds.
            // Default event name; configurable per implementation.
            extensionId: coreExtId,
            delegateDescriptorId: CORE_DESCRIPTORS.custom_event,
            settings: rcCustomEventSettings("ecommerce:addToCart"),
            name: "Add to Cart Event",
          },
          {
            extensionId: alloyExtId,
            delegateDescriptorId: ALLOY_DESCRIPTORS.send_event,
            settings: rcSendEventArchetypeSettings("XDM - Add to Cart"),
            name: "Send Add to Cart",
          },
        ]),
    },
    {
      name: "Checkout - Target WebSDK - Checkout Start",
      build: async (propertyId, coreExtId, alloyExtId) =>
        createRuleWithComponents(propertyId, "Checkout - Target WebSDK - Checkout Start", [
          {
            extensionId: coreExtId,
            delegateDescriptorId: CORE_DESCRIPTORS.dom_ready,
            settings: JSON.stringify({}),
            name: "DOM Ready",
            timeout: 2000,
          },
          {
            extensionId: coreExtId,
            delegateDescriptorId: CORE_DESCRIPTORS.path_condition,
            settings: rcPathConditionSettings("/checkout", false),
            name: "Path matches /checkout",
          },
          {
            extensionId: alloyExtId,
            delegateDescriptorId: ALLOY_DESCRIPTORS.send_event,
            settings: rcSendEventArchetypeSettings("XDM - Checkout Start"),
            name: "Send Checkout Start",
          },
        ]),
    },
  ];
}

// ── Helpers ─────────────────────────────────────────────────
async function resolveCoreAndAlloy(
  propertyId: string
): Promise<{ coreExtId: string; alloyExtId: string }> {
  const exts = await reactorPaginate<{
    name?: string;
    extension_package_name?: string;
  }>(`/properties/${propertyId}/extensions`);
  const match = (target: string) =>
    exts.find((e) => {
      const a = e.attributes;
      return a.name === target || a.extension_package_name === target;
    });
  const core = match("core");
  const alloy = match("adobe-alloy");
  if (!core || !alloy) {
    throw new Error(
      `apply_archetype: required extensions missing on property ${propertyId} (core=${!!core}, alloy=${!!alloy}). Run setup_target_websdk first.`
    );
  }
  return { coreExtId: core.id, alloyExtId: alloy.id };
}

// ── Public API ──────────────────────────────────────────────
export async function applyArchetype(
  input: ApplyArchetypeInput
): Promise<ApplyArchetypeResult> {
  if (input.archetype !== "ecommerce_standard") {
    throw new Error(
      `Unknown archetype '${input.archetype}'. v1.1 only supports 'ecommerce_standard'; the b2b_lead_gen / media_publisher / saas_funnel archetypes are scheduled for v1.2.`
    );
  }

  const { coreExtId, alloyExtId } = await resolveCoreAndAlloy(input.propertyId);

  // Discover existing DEs and rules for idempotency
  const existingDes = await reactorPaginate<{ name?: string }>(
    `/properties/${input.propertyId}/data_elements`
  );
  const existingDesByName = new Map(
    existingDes.map((d) => [(d.attributes.name ?? "") as string, d.id])
  );
  const existingRules = await reactorPaginate<{ name?: string }>(
    `/properties/${input.propertyId}/rules`
  );
  const existingRulesByName = new Map(
    existingRules.map((r) => [(r.attributes.name ?? "") as string, r.id])
  );

  // Create DEs
  const desResults: ApplyArchetypeResult["data_elements_added"] = [];
  for (const de of ECOMMERCE_DES) {
    if (existingDesByName.has(de.name)) {
      desResults.push({
        name: de.name,
        id: existingDesByName.get(de.name)!,
        status: "skipped",
      });
      continue;
    }
    const extensionId = de.extension === "alloy" ? alloyExtId : coreExtId;
    const body = {
      data: {
        type: "data_elements",
        attributes: {
          name: de.name,
          delegate_descriptor_id: de.delegateDescriptorId,
          settings: ensureSettingsString(de.settingsBuilder(input)),
          enabled: true,
          default_value: de.defaultValue ?? "",
          force_lower_case: false,
          clean_text: false,
          storage_duration: de.storageDuration,
        },
        relationships: {
          extension: { data: { id: extensionId, type: "extensions" } },
        },
      },
    };
    const resp = await reactorRequest<JsonApiSingleResponse>(
      `/properties/${input.propertyId}/data_elements`,
      { method: "POST", body }
    );
    desResults.push({ name: de.name, id: getId(resp), status: "created" });
  }

  // Create rules
  const ruleResults: ApplyArchetypeResult["rules_added"] = [];
  for (const r of ecommerceRules()) {
    if (existingRulesByName.has(r.name)) {
      ruleResults.push({
        name: r.name,
        id: existingRulesByName.get(r.name)!,
        status: "skipped",
      });
      continue;
    }
    const built = await r.build(input.propertyId, coreExtId, alloyExtId);
    ruleResults.push({
      name: r.name,
      id: built.ruleId,
      status: "created",
      components: built.components,
    });
  }

  const notes = [
    `Applied archetype: ${input.archetype}`,
    "Added 7 ecommerce-specific data elements (Product SKU/Name/Category, Cart Count, 3 XDM payloads).",
    "Added 3 ecommerce rules: PDP product-view (fires on /product/* paths), Add to Cart (listens for 'ecommerce:addToCart' custom event), Checkout Start (fires on /checkout).",
    "The Add to Cart rule listens for a custom DOM event 'ecommerce:addToCart' — your site must dispatch this event when a user adds an item to cart. Example: document.dispatchEvent(new CustomEvent('ecommerce:addToCart'))",
    "PDP and Checkout rules use path matching — verify the URL patterns match your site's structure.",
    "All ecommerce XDM rules pass Target profile data via the existing 'Target - Send Event Data' wrapper DE.",
  ];

  const next_steps = [
    "Run create_dev_library to rebuild the property with the new ecommerce resources.",
    "Hook up the 'ecommerce:addToCart' custom event from your site's add-to-cart handler.",
    "Verify the PDP path regex (/product/.*) matches your site — override via the create_standard_rules tool if not.",
    "Deploy Target activities targeting any of the new XDM event types (commerce.productViews, commerce.productListAdds, commerce.checkouts) for recommendations or personalization.",
  ];

  return {
    archetype: input.archetype,
    data_elements_added: desResults,
    rules_added: ruleResults,
    notes,
    next_steps,
  };
}
