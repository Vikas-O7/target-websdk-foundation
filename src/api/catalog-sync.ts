/**
 * Catalog sync — upgrade an existing Tags property to the current
 * standard catalog without re-running the full orchestrator.
 *
 * Problem this solves: when the standard DE/rule catalog grows between
 * MCP versions (e.g. v1.1 added `Page - Type` + `Target - Send Event
 * Data` DEs; v1.3 reshapes the page-load rule), properties created
 * under an older MCP version don't auto-acquire the new resources.
 * The orchestrator's idempotency-by-name correctly skips existing
 * items, but never KNOWS to add the new ones — because it doesn't
 * compare full catalogs.
 *
 * `sync_property_catalog` makes this explicit: pass a property ID,
 * the tool figures out what's missing from the standard catalog,
 * and only adds the gaps. Existing DEs and rules are untouched.
 *
 * Limits (honest):
 *   - Doesn't UPDATE existing DEs / rules. If you previously set the
 *     page-load rule to use DOM Ready (v1.2) and v1.3 changes it to
 *     Library Loaded, this tool sees "rule exists" and leaves it.
 *     To upgrade in place, delete the old rule via Reactor first.
 *   - Doesn't touch the Web SDK extension settings. To update
 *     prehiding scope or consent mode, re-run `install_websdk_extension`
 *     directly.
 *   - Same revision-model gotcha as everywhere else: the new DEs/rules
 *     this tool adds are HEAD revisions. Re-run `create_dev_library`
 *     after to publish them into a build.
 */

import { reactorPaginate } from "./reactor-client.js";
import {
  createStandardDataElements,
  createStandardRules,
} from "./setup.js";
import type { DataElementSelection, PageLoadCondition } from "./templates.js";

// Local copies of category names — keep in sync with templates.ts
// DECategory if it grows. We mirror here to avoid pulling unused
// type re-exports into the runtime path.
const ALL_CATEGORIES = [
  "pageContext",
  "identity",
  "targetProfile",
  "xdm",
  "environment",
  "orderTracking",
] as const;

export interface SyncCatalogInput {
  propertyId: string;
  /**
   * Data-layer paths for any DEs that don't exist yet and need creating.
   * Existing DEs are NOT modified — these paths only affect newly-added
   * DEs.
   */
  pageNamePath?: string;
  crmIdPath?: string;
  orderIdPath?: string;
  orderTotalPath?: string;
  /**
   * Selection passed through to createStandardDataElements / Rules.
   * Default: enable all DE categories except orderTracking; include
   * the page-load rule. To force ONLY new items, the underlying
   * helpers' idempotency-by-name handles it.
   */
  dataElementSelection?: DataElementSelection;
  /** v1.3 — gate page-load rule on conditions if added. */
  pageLoadConditions?: PageLoadCondition[];
  /** v1.3 — opt out of page-load rule creation. Default true. */
  includePageLoadRule?: boolean;
  /** Include order-confirmation rule. Default false (matches orchestrator). */
  includeOrderRule?: boolean;
  /** Don't try to rebuild the dev library after sync. Default true (auto-rebuild). */
  rebuildDevLibraryAfter?: boolean;
}

export interface SyncCatalogResult {
  property_id: string;
  before: {
    data_element_count: number;
    rule_count: number;
  };
  data_elements: {
    added: Array<{ name: string; id: string }>;
    skipped_existing: Array<{ name: string; id: string }>;
  };
  rules: {
    added: Array<{ name: string; ruleId: string; components: number }>;
    skipped_existing: Array<{ name: string; reason: string }>;
  };
  next_steps: string[];
}

// ── Resolve extension IDs we need before calling create_standard_* ──
async function resolveExtIds(
  propertyId: string
): Promise<{ alloyExtId: string; coreExtId: string }> {
  // Filter to HEAD revisions (revision_number=0). The revisioned
  // instances Reactor mints during builds are pinned to specific
  // package versions and aren't useful targets for new DE/rule POSTs.
  const exts = await reactorPaginate<{
    name?: string;
    extension_package_name?: string;
  }>(`/properties/${propertyId}/extensions`, {
    params: { "filter[revision_number]": "EQ 0" },
  });
  const match = (target: string) =>
    exts.find((e) => {
      const a = e.attributes;
      return a.name === target || a.extension_package_name === target;
    });
  const alloy = match("adobe-alloy");
  const core = match("core");
  if (!alloy || !core) {
    throw new Error(
      `sync_property_catalog: required extensions missing on property ${propertyId} (core=${!!core}, alloy=${!!alloy}). The property must have the Web SDK installed before catalog sync. Run setup_target_websdk or install_websdk_extension first.`
    );
  }
  return { alloyExtId: alloy.id, coreExtId: core.id };
}

// ── Public ──────────────────────────────────────────────────
export async function syncPropertyCatalog(
  input: SyncCatalogInput
): Promise<SyncCatalogResult> {
  // Snapshot baseline counts for the report
  const [existingDes, existingRules] = await Promise.all([
    reactorPaginate(`/properties/${input.propertyId}/data_elements`, {
      params: { "filter[revision_number]": "EQ 0" },
    }),
    reactorPaginate(`/properties/${input.propertyId}/rules`, {
      params: { "filter[revision_number]": "EQ 0" },
    }),
  ]);
  const existingDeIdsByName = new Map<string, string>(
    existingDes.map((d) => [
      (d.attributes as { name?: string }).name ?? "",
      d.id,
    ])
  );
  const before = {
    data_element_count: existingDes.length,
    rule_count: existingRules.length,
  };

  const { alloyExtId, coreExtId } = await resolveExtIds(input.propertyId);

  // ── 1. Data elements ──
  const desRes = await createStandardDataElements({
    propertyId: input.propertyId,
    alloyExtensionId: alloyExtId,
    coreExtensionId: coreExtId,
    pageNameDataLayerPath:
      input.pageNamePath ?? "digitalData.page.pageInfo.pageName",
    crmIdDataLayerPath:
      input.crmIdPath ??
      "digitalData.user[0].profile[0].profileInfo.profileID",
    orderIdPath: input.orderIdPath,
    orderTotalPath: input.orderTotalPath,
    selection: input.dataElementSelection ?? {
      // Default for catalog sync: all non-ecommerce categories ON.
      // The whole point of this tool is to backfill DEs the property
      // is missing. orderTracking stays off by default; callers who
      // want it set { orderTracking: true } explicitly.
      pageContext: true,
      identity: true,
      targetProfile: true,
      xdm: true,
      environment: true,
      orderTracking: false,
    },
  });

  // Bucket actually-newly-created vs already-existed
  const addedDes: Array<{ name: string; id: string }> = [];
  const skippedExistingDes: Array<{ name: string; id: string }> = [];
  for (const item of desRes.created) {
    if (existingDeIdsByName.has(item.name)) {
      skippedExistingDes.push({ name: item.name, id: item.id });
    } else {
      addedDes.push({ name: item.name, id: item.id });
    }
  }

  // ── 2. Rules ──
  const rulesRes = await createStandardRules({
    propertyId: input.propertyId,
    alloyExtensionId: alloyExtId,
    coreExtensionId: coreExtId,
    includePageLoadRule: input.includePageLoadRule ?? true,
    pageLoadConditions: input.pageLoadConditions,
    includeOrderRule: input.includeOrderRule ?? false,
  });

  // ── 3. Next-steps text ──
  const next_steps: string[] = [];
  if (addedDes.length === 0 && rulesRes.created.length === 0) {
    next_steps.push(
      "Property is already in sync with the v1.3 catalog. No changes made."
    );
  } else {
    next_steps.push(
      `Added ${addedDes.length} data element(s) and ${rulesRes.created.length} rule(s).`
    );
    next_steps.push(
      "Run create_dev_library next so the new resources are included in the next build, then update the embed code on your site if the dev library script URL changed."
    );
    next_steps.push(
      "Run validate_tags_property afterward to confirm the v1.3 baseline (Page-Type DE, Send Event Data DE, Library Loaded event, Guided Events config) is in place."
    );
  }
  void ALL_CATEGORIES; // referenced for future selective-sync UI work

  return {
    property_id: input.propertyId,
    before,
    data_elements: {
      added: addedDes,
      skipped_existing: skippedExistingDes,
    },
    rules: {
      added: rulesRes.created,
      skipped_existing: rulesRes.skipped,
    },
    next_steps,
  };
}
