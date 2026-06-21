/**
 * Data Collection — End-to-end setup orchestrator.
 *
 * `setup_target_websdk` chains every step from zero to a working dev
 * library + embed code. Each step appends to a progress trail; if anything
 * fails, the partial state is returned so the run is resumable.
 *
 * Spec: Adobe Reactor / Edge Metadata API.
 */

import {
  createDatastream,
  addTargetToDatastream,
  addAnalyticsToDatastream,
  listDatastreams,
} from "./datastreams.js";
import {
  createTagsProperty,
  setupPropertyInfrastructure,
  installWebSdkExtension,
  resolveExtensionIds,
  createStandardDataElements,
  createStandardRules,
} from "./setup.js";
import { createDevLibrary } from "./library.js";
import { runFullValidation } from "./validation.js";
import { config } from "../config.js";

// ── Types ───────────────────────────────────────────────────
export interface SetupInput {
  // Datastream
  datastreamName: string;
  targetClientCode: string;
  targetPropertyToken?: string;
  includeA4t?: boolean;
  reportSuites?: string[];
  trackingServer?: string;

  // Property
  propertyName: string;
  domains: string[];

  // WebSDK extension
  flickerStyle?: string;
  /**
   * v1.1 — preferred prehiding scope. CSS selectors that should be hidden
   * while Target loads. Best practice: scope to only the containers that
   * will host personalization (hero, product cards, CTAs). When omitted,
   * falls back to whole-body prehide and emits a validate-time warn.
   */
  flickerSelectors?: string[];
  /**
   * v1.1 — Web SDK consent default. `"in"` (default) = SDK fires Target
   * calls immediately. `"pending"` = SDK waits for an explicit consent
   * grant via a Set Consent action — required for EU/UK GDPR-compliant
   * setups. Wire your CMP to dispatch the consent grant.
   */
  consentMode?: "in" | "pending";

  // Data elements
  pageNamePath?: string;
  crmIdPath?: string;
  includeOrderDes?: boolean;

  // Rules
  renderDecisions?: boolean;
  includeOrderRule?: boolean;
  orderPagePath?: string;

  // Library
  libraryName?: string;

  // Post-setup
  runValidation?: boolean;
}

export interface SetupResult {
  status: "success" | "partial_failure";
  failed_at_step?: string;
  failure_details?: string;
  progress: string[];
  datastream_id?: string;
  property_id?: string;
  environments?: Record<string, { id: string; embed_code: string }>;
  extensions?: Array<{ name: string; id: string }>;
  data_elements_created?: number;
  rules_created?: number;
  library?: { id: string; build_status: string };
  validation?: { grade: string; score: number; summary: string };
  dev_embed_code?: string;
  next_steps: string[];
}

// ── Public: full wizard ─────────────────────────────────────
export async function setupTargetWebsdk(
  input: SetupInput
): Promise<SetupResult> {
  const progress: string[] = [];
  const result: SetupResult = {
    status: "success",
    progress,
    next_steps: [],
  };

  const recordFailure = (step: string, err: unknown): SetupResult => {
    result.status = "partial_failure";
    result.failed_at_step = step;
    result.failure_details = (err as Error).message;
    result.next_steps = [
      `Inspect the error in failure_details.`,
      `Fix the underlying cause and re-run setup_target_websdk (idempotent steps skip existing resources).`,
      `Resources created so far are listed in the progress trail and can be reused.`,
    ];
    return result;
  };

  // 1. Datastream — reuse if name already exists, else create.
  // Adobe's Datastream API has no name-uniqueness constraint (multiple
  // datastreams CAN share a name); the orchestrator imposes the idempotency
  // contract because re-running setup_target_websdk with the same inputs
  // should be safe and produce the same end state, not silently spawn
  // duplicate datastreams in the tenant.
  try {
    const existing = await listDatastreams(input.datastreamName);
    const exactMatch = existing.datastreams.find(
      (d) => d.name === input.datastreamName
    );
    if (exactMatch) {
      result.datastream_id = exactMatch.id;
      progress.push(
        `Found existing datastream ${exactMatch.id} (${exactMatch.name})`
      );
    } else {
      const ds = await createDatastream({ name: input.datastreamName });
      result.datastream_id = ds.datastreamId;
      progress.push(`Created datastream ${ds.datastreamId} (${ds.name})`);
    }
  } catch (e) {
    return recordFailure("create_datastream", e);
  }

  // 2. Add Target service
  try {
    await addTargetToDatastream(result.datastream_id!, {
      clientCode: input.targetClientCode,
      propertyToken: input.targetPropertyToken ?? null,
      environment: "production",
      timeout: 5000,
      a4tEnabled: input.includeA4t ?? false,
    });
    progress.push("Added Target service to datastream");
  } catch (e) {
    return recordFailure("add_target_to_datastream", e);
  }

  // 3. Add Analytics service (A4T)
  if (input.includeA4t) {
    if (!input.reportSuites || input.reportSuites.length === 0 || !input.trackingServer) {
      return recordFailure(
        "add_analytics_to_datastream",
        new Error(
          "includeA4t=true requires reportSuites and trackingServer to be provided."
        )
      );
    }
    try {
      await addAnalyticsToDatastream(result.datastream_id!, {
        reportSuites: input.reportSuites,
        trackingServer: input.trackingServer,
      });
      progress.push("Added Analytics service (A4T enabled)");
    } catch (e) {
      return recordFailure("add_analytics_to_datastream", e);
    }
  }

  // 4. Create Tags property
  try {
    const prop = await createTagsProperty({
      name: input.propertyName,
      domains: input.domains,
      returnIfExists: true,
    });
    result.property_id = prop.propertyId;
    progress.push(
      `${prop.alreadyExisted ? "Found existing" : "Created"} property ${prop.propertyId} (${prop.name})`
    );
  } catch (e) {
    return recordFailure("create_tags_property", e);
  }

  // 5. Property infrastructure (host + envs)
  let devEnvironmentId = "";
  let envsForResult: Record<string, { id: string; embed_code: string }> = {};
  try {
    const infra = await setupPropertyInfrastructure(result.property_id!);
    devEnvironmentId = infra.environments.development.id;
    envsForResult = {
      development: {
        id: infra.environments.development.id,
        embed_code: infra.environments.development.embedCode,
      },
      staging: {
        id: infra.environments.staging.id,
        embed_code: infra.environments.staging.embedCode,
      },
      production: {
        id: infra.environments.production.id,
        embed_code: infra.environments.production.embedCode,
      },
    };
    result.environments = envsForResult;
    progress.push(`Created host + dev/staging/prod environments`);
  } catch (e) {
    return recordFailure("setup_property_infrastructure", e);
  }

  // 6. Install Web SDK extension
  let alloyExtensionId = "";
  let coreExtensionId = "";
  try {
    const ext = await installWebSdkExtension({
      propertyId: result.property_id!,
      datastreamId: result.datastream_id!,
      orgId: config.ADOBE_ORG_ID,
      flickerStyle: input.flickerStyle,
      flickerSelectors: input.flickerSelectors,
      defaultConsent: input.consentMode ?? "in",
    });
    alloyExtensionId = ext.extensionId;
    progress.push(
      `${ext.alreadyInstalled ? "Found existing" : "Installed"} Web SDK extension ${ext.extensionId}`
    );
    const ids = await resolveExtensionIds(result.property_id!);
    coreExtensionId = ids.coreExtensionId;
    result.extensions = [
      { name: "AEP Web SDK", id: alloyExtensionId },
      { name: "Core", id: coreExtensionId },
    ];
  } catch (e) {
    return recordFailure("install_websdk_extension", e);
  }

  // 7. Create standard data elements
  try {
    const des = await createStandardDataElements({
      propertyId: result.property_id!,
      alloyExtensionId,
      coreExtensionId,
      pageNameDataLayerPath:
        input.pageNamePath ?? "digitalData.page.pageInfo.pageName",
      crmIdDataLayerPath:
        input.crmIdPath ??
        "digitalData.user[0].profile[0].profileInfo.profileID",
      includeOrderDes: input.includeOrderDes ?? false,
    });
    result.data_elements_created = des.total;
    progress.push(
      `Data elements: ${des.created.length} ready (${des.skipped.length} skipped — already existed)`
    );
  } catch (e) {
    return recordFailure("create_standard_data_elements", e);
  }

  // 8. Create standard rules
  try {
    const rules = await createStandardRules({
      propertyId: result.property_id!,
      alloyExtensionId,
      coreExtensionId,
      renderDecisions: input.renderDecisions ?? true,
      includeOrderRule: input.includeOrderRule ?? false,
      orderPagePath: input.orderPagePath ?? "/order-confirmation",
    });
    result.rules_created = rules.created.length;
    progress.push(
      `Rules: ${rules.created.length} ready (${rules.skipped.length} skipped — already existed)`
    );
  } catch (e) {
    return recordFailure("create_standard_rules", e);
  }

  // 9. Build dev library
  let devEmbedCode = "";
  try {
    const lib = await createDevLibrary({
      propertyId: result.property_id!,
      devEnvironmentId,
      libraryName: input.libraryName,
    });
    result.library = {
      id: lib.library_id,
      build_status: lib.build_status,
    };
    devEmbedCode = lib.embed_code;
    result.dev_embed_code = devEmbedCode;
    progress.push(
      `Built dev library ${lib.library_id} (${lib.build_status} in ${lib.build_duration_seconds}s)`
    );
  } catch (e) {
    return recordFailure("create_dev_library", e);
  }

  // 10. Optional validation
  if (input.runValidation ?? true) {
    try {
      const v = await runFullValidation({
        datastreamId: result.datastream_id!,
        propertyId: result.property_id!,
      });
      result.validation = {
        grade: v.grade,
        score: v.score,
        summary: v.summary,
      };
      progress.push(
        `Validation: grade ${v.grade}, score ${v.score} — ${v.summary}`
      );
    } catch (e) {
      // Validation failure is non-fatal; we still consider setup successful.
      progress.push(
        `Validation step failed (non-fatal): ${(e as Error).message}`
      );
    }
  }

  result.next_steps = [
    "Add the dev_embed_code <script> tag to your website's <head>.",
    "Deploy actual Target activities in Target → Activities for the URLs you wired.",
    "Call check_website_implementation once the code is deployed to verify the script is loading.",
    "Call run_full_validation for final sign-off after the activity is live.",
  ];

  return result;
}
