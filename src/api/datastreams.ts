/**
 * Data Collection — Datastream operations.
 *
 * Calls Adobe's undocumented Datastream Configuration API at
 * `edge.adobe.io/metadata/namespaces/edge/datasets/datastreams/records`.
 * See `edge-metadata-client.ts` for the why/how of this endpoint and the
 * quirks (Activation-DTM api-key, HAL+JSON shape, services as settings
 * sub-fields rather than sub-resources).
 *
 * Spec note: this file deliberately departs from the original
 * Adobe Reactor API docs Layer 1 design. The spec assumed
 * `platform.adobe.io/data/core/edge/datastreams` with sub-resource
 * services. Live API is different: edge.adobe.io with all services
 * embedded in the record's settings object. Tool surfaces are kept
 * (same input shape where reasonable) but a few legacy params are
 * dropped because they don't map to anything in the real API.
 */

import {
  edgeMetadataRequest,
  type DatastreamRecord,
  type DatastreamListResponse,
  type DatastreamSettings,
  type TargetServiceSettings,
  type AnalyticsServiceSettings,
} from "./edge-metadata-client.js";
import type { TargetServiceInput, AnalyticsServiceInput } from "./templates.js";

// ── Public type contracts ──────────────────────────────────
export interface DatastreamSummary {
  id: string;
  name: string;
  description?: string;
  services: string[];
}

export interface DatastreamListResult {
  datastreams: DatastreamSummary[];
  count: number;
}

// ── Helpers ─────────────────────────────────────────────────
function summarize(rec: DatastreamRecord): DatastreamSummary {
  const settings = rec.data.settings ?? {};
  const services: string[] = [];
  // Map internal setting keys → friendly service names
  const SERVICE_MAP: Record<string, string> = {
    com_adobe_target: "Target",
    com_adobe_analytics: "Analytics",
    com_adobe_audience_manager: "AudienceManager",
    com_adobe_identity: "Identity",
    com_adobe_media_analytics: "MediaAnalytics",
    com_adobe_experience_platform: "ExperiencePlatform",
  };
  for (const [key, friendly] of Object.entries(SERVICE_MAP)) {
    const s = (settings as Record<string, unknown>)[key];
    if (s && typeof s === "object" && (s as { enabled?: boolean }).enabled) {
      services.push(friendly);
    }
  }
  return {
    id: rec._system?.id ?? "",
    name: rec.data?.title ?? "",
    services,
  };
}

// ── List datastreams ────────────────────────────────────────
export async function listDatastreams(
  nameFilter?: string
): Promise<DatastreamListResult> {
  // Minimum page size enforced by Adobe is 10 (EXEG-3181 below that).
  const resp = await edgeMetadataRequest<DatastreamListResponse>("/", {
    params: { limit: 100, orderBy: "-updatedAt" },
  });
  const records = resp._embedded?.records ?? [];
  const all = records.map(summarize).filter((d) => d.id);
  const filtered = nameFilter
    ? all.filter((d) =>
        d.name.toLowerCase().includes(nameFilter.toLowerCase())
      )
    : all;
  return { datastreams: filtered, count: filtered.length };
}

// ── Create datastream ───────────────────────────────────────
export interface CreateDatastreamInput {
  name: string;
  description?: string;
  /** Whether to enable Target migration mode (parallel at.js + Web SDK). */
  targetMigrationEnabled?: boolean;
}

export async function createDatastream(
  input: CreateDatastreamInput
): Promise<{ datastreamId: string; name: string; status: "created" }> {
  // Per the live UI behavior, a new datastream starts with `enabled: true`
  // and a minimal settings object. Services are added later via PUT.
  const body = {
    data: {
      title: input.name,
      enabled: true,
      settings: {
        input: {},
        // Reasonable defaults that match what the UI sends on creation:
        user_agent_collection: { enabled: true },
      },
    },
  };
  type CreateResp = DatastreamRecord;
  const resp = await edgeMetadataRequest<CreateResp>("/", {
    method: "POST",
    body,
  });
  const id = resp._system?.id;
  if (!id) {
    throw new Error(
      `Datastream creation succeeded but no id returned. Raw: ${JSON.stringify(resp).slice(0, 500)}`
    );
  }
  return { datastreamId: id, name: input.name, status: "created" };
}

// ── Read datastream ────────────────────────────────────────
export interface DatastreamDetail {
  id: string;
  name: string;
  description: string;
  settings: DatastreamSettings;
  services: Array<{ type: string; enabled: boolean; settings: unknown }>;
  revision: number;
}

export async function getDatastreamDetail(
  datastreamId: string
): Promise<DatastreamDetail> {
  const rec = await edgeMetadataRequest<DatastreamRecord>(`/${datastreamId}`);
  const settings = rec.data?.settings ?? {};
  // Project services as the legacy {type, enabled, settings} list the rest of
  // the codebase (e.g. validation tool) expects.
  const services: DatastreamDetail["services"] = [];
  const SERVICE_NAME_MAP: Record<string, string> = {
    com_adobe_target: "Target",
    com_adobe_analytics: "Analytics",
    com_adobe_audience_manager: "AudienceManager",
    com_adobe_identity: "Identity",
    com_adobe_media_analytics: "MediaAnalytics",
    com_adobe_experience_platform: "ExperiencePlatform",
  };
  for (const [key, type] of Object.entries(SERVICE_NAME_MAP)) {
    const s = (settings as Record<string, unknown>)[key] as
      | { enabled?: boolean }
      | undefined;
    if (s && typeof s === "object") {
      services.push({
        type,
        enabled: !!s.enabled,
        settings: s,
      });
    }
  }
  return {
    id: rec._system?.id ?? datastreamId,
    name: rec.data?.title ?? "",
    description: "",
    settings,
    services,
    revision: rec._system?.revision ?? 0,
  };
}

// ── Service mutators (read-modify-write) ───────────────────
async function modifyServiceAndPut(
  datastreamId: string,
  mutator: (settings: DatastreamSettings) => void
): Promise<DatastreamRecord> {
  const rec = await edgeMetadataRequest<DatastreamRecord>(`/${datastreamId}`);
  const settings: DatastreamSettings = rec.data?.settings ?? {};
  mutator(settings);
  // PUT the full record back. The Edge Metadata API's update semantics are
  // PUT-based replace; the server preserves _system fields.
  const body = {
    data: {
      title: rec.data.title,
      enabled: rec.data.enabled,
      settings,
    },
  };
  return await edgeMetadataRequest<DatastreamRecord>(`/${datastreamId}`, {
    method: "PUT",
    body,
  });
}

// ── Add Target service ─────────────────────────────────────
export async function addTargetToDatastream(
  datastreamId: string,
  input: TargetServiceInput
): Promise<{
  success: true;
  service: "Target";
  property_token: string | null;
  updated: boolean;
}> {
  // The live API's Target service shape is much smaller than the spec
  // assumed. We honor only the fields the API actually accepts:
  //   • enabled (always true after this call)
  //   • propertyToken (optional)
  //   • environmentId (optional — accepts the Target environment number)
  //
  // The spec's `clientCode` field is INTENTIONALLY DROPPED — the
  // datastream API has no concept of client code; Target tenant is org-
  // level, derived from the IMS org of the datastream. We ignore the
  // input's clientCode silently for backward compatibility.
  let wasUpdated = false;
  const result = await modifyServiceAndPut(datastreamId, (settings) => {
    const existing = settings.com_adobe_target ?? { enabled: false };
    wasUpdated = !!existing.enabled;
    const next: TargetServiceSettings = {
      ...existing,
      enabled: true,
    };
    if (input.propertyToken) next.propertyToken = input.propertyToken;
    // Map legacy "production"/"staging"/"development" string to environmentId
    // only if the caller provided one AND we don't already have an
    // environmentId set. Best-effort mapping — Target's actual env IDs are
    // numeric and tenant-specific, so this is a hint only.
    if (input.environment && !existing.environmentId) {
      // Don't fabricate a numeric environmentId from the string — leave
      // unset and let the consultant fill it in via UI/tool if needed.
      // (Setting it here would risk pointing at a wrong env.)
    }
    settings.com_adobe_target = next;
  });
  return {
    success: true,
    service: "Target",
    property_token:
      result.data.settings.com_adobe_target?.propertyToken ?? null,
    updated: wasUpdated,
  };
}

// ── Add Analytics service ──────────────────────────────────
export async function addAnalyticsToDatastream(
  datastreamId: string,
  input: AnalyticsServiceInput
): Promise<{
  success: true;
  service: "Analytics";
  report_suites: string[];
  updated: boolean;
}> {
  // Live Analytics service schema is just { enabled, reportSuites }.
  // The spec's `trackingServer` / `sslTrackingServer` fields don't exist
  // here — the tracking server is derived from the report suite config in
  // Analytics itself, not stored on the datastream. We accept the inputs
  // for backward compat but silently ignore them.
  let wasUpdated = false;
  const result = await modifyServiceAndPut(datastreamId, (settings) => {
    const existing = settings.com_adobe_analytics ?? {
      enabled: false,
      reportSuites: [],
    };
    wasUpdated = !!existing.enabled;
    const next: AnalyticsServiceSettings = {
      enabled: true,
      reportSuites: input.reportSuites,
    };
    settings.com_adobe_analytics = next;
  });
  return {
    success: true,
    service: "Analytics",
    report_suites:
      result.data.settings.com_adobe_analytics?.reportSuites ?? [],
    updated: wasUpdated,
  };
}
