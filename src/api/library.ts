/**
 * Data Collection — Library + build operations.
 *
 * Spec: Adobe Reactor / Edge Metadata API.
 *
 * The `create_dev_library` flow:
 *   1. POST /properties/{id}/libraries  → libraryId
 *   2. Fetch all extensions + data elements + rules on the property
 *   3. POST /libraries/{id}/relationships/resources  with the bare ARRAY
 *      (no outer {data: ...} wrapper — JSON:API relationship update form)
 *   4. POST /libraries/{id}/builds  → buildId
 *   5. Poll GET /builds/{id} until status === "succeeded" / "failed"
 *   6. Return the dev embed code
 *
 * Step 3 is the easy-to-miss gotcha. The spec is explicit.
 */

import {
  reactorRequest,
  reactorPaginate,
  getAttr,
  getId,
  jsonApiCreateBody,
  type JsonApiSingleResponse,
} from "./reactor-client.js";
import { getEmbedCode } from "./setup.js";

// ── Types ───────────────────────────────────────────────────
export interface CreateDevLibraryInput {
  propertyId: string;
  devEnvironmentId: string;
  libraryName?: string;
  buildTimeoutSeconds?: number;
}

export interface DevLibraryResult {
  library_id: string;
  build_id: string;
  build_status: "succeeded" | "failed" | "timeout";
  build_duration_seconds: number;
  embed_code: string;
  script_url: string;
  resources_added: { extensions: number; data_elements: number; rules: number };
  failed_details?: string;
}

// ── Helpers ─────────────────────────────────────────────────
function defaultLibraryName(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `Target WebSDK Setup - ${y}-${m}-${d}`;
}

async function gatherResourceIds(propertyId: string): Promise<{
  extensions: string[];
  data_elements: string[];
  rules: string[];
}> {
  // Filter to HEAD revisions (revision_number=0) — these are the editable
  // drafts. We must NOT include older revisions in the list to revise; only
  // heads can be revised into a new revision for inclusion in a library.
  const params = { "filter[revision_number]": "EQ 0" };
  const [exts, des, rules] = await Promise.all([
    reactorPaginate(`/properties/${propertyId}/extensions`, { params }),
    reactorPaginate(`/properties/${propertyId}/data_elements`, { params }),
    reactorPaginate(`/properties/${propertyId}/rules`, { params }),
  ]);
  return {
    extensions: exts.map((r) => r.id),
    data_elements: des.map((r) => r.id),
    rules: rules.map((r) => r.id),
  };
}

/**
 * Reactor uses a draft/revision model: created resources are drafts
 * (`revision_number: 0`). Libraries can only reference stable revisions.
 * `PATCH /<type>/<id>` with `meta.action: "revise"` mints a new revision
 * (returns a new resource id with `revision_number: 1`).
 *
 * Caller passes the head id; this returns the revision id to attach to a
 * library. Spec gotcha: the head id stays editable; the returned id is
 * immutable and is the one libraries link to.
 */
async function reviseResource(
  resourceType: "extensions" | "data_elements" | "rules",
  headId: string
): Promise<string> {
  type RevisedResp = { data?: { id?: string } };
  const resp = await reactorRequest<RevisedResp>(
    `/${resourceType}/${headId}`,
    {
      method: "PATCH",
      body: {
        data: { id: headId, type: resourceType, meta: { action: "revise" } },
      },
    }
  );
  const revisedId = resp.data?.id;
  if (!revisedId) {
    throw new Error(
      `Reactor revise of ${resourceType}/${headId} returned no id. Raw: ${JSON.stringify(resp)}`
    );
  }
  return revisedId;
}

async function reviseAllHeads(heads: {
  extensions: string[];
  data_elements: string[];
  rules: string[];
}): Promise<{
  extensions: string[];
  data_elements: string[];
  rules: string[];
}> {
  const [extRev, deRev, ruleRev] = await Promise.all([
    Promise.all(heads.extensions.map((id) => reviseResource("extensions", id))),
    Promise.all(
      heads.data_elements.map((id) => reviseResource("data_elements", id))
    ),
    Promise.all(heads.rules.map((id) => reviseResource("rules", id))),
  ]);
  return { extensions: extRev, data_elements: deRev, rules: ruleRev };
}

async function addResourcesToLibrary(
  libraryId: string,
  revisions: { extensions: string[]; data_elements: string[]; rules: string[] }
): Promise<void> {
  // Per-resource-type JSON:API relationship POSTs with `{data: [...]}` wrap.
  // The unified `/libraries/{id}/relationships/resources` endpoint the spec
  // described does not exist (returns 404). Confirmed live 2026-06-13.
  const attach = async (
    type: "extensions" | "data_elements" | "rules",
    ids: string[]
  ): Promise<void> => {
    if (ids.length === 0) return;
    await reactorRequest(`/libraries/${libraryId}/relationships/${type}`, {
      method: "POST",
      body: { data: ids.map((id) => ({ id, type })) },
    });
  };
  await attach("extensions", revisions.extensions);
  await attach("data_elements", revisions.data_elements);
  await attach("rules", revisions.rules);
}

async function pollBuild(
  buildId: string,
  timeoutSec: number
): Promise<{
  status: "succeeded" | "failed" | "timeout";
  durationSec: number;
  details?: string;
}> {
  const POLL_INTERVAL_MS = 5000;
  const start = Date.now();
  const deadline = start + timeoutSec * 1000;
  let lastStatus = "pending";
  let lastDetails = "";
  while (Date.now() < deadline) {
    const resp = await reactorRequest<JsonApiSingleResponse>(
      `/builds/${buildId}`
    );
    const status = (getAttr<string>(resp, "status") ?? "pending").toLowerCase();
    lastStatus = status;
    const details = getAttr<string>(resp, "status_details");
    if (details) lastDetails = details;
    if (status === "succeeded" || status === "success") {
      return {
        status: "succeeded",
        durationSec: Math.round((Date.now() - start) / 1000),
      };
    }
    if (status === "failed" || status === "failure") {
      return {
        status: "failed",
        durationSec: Math.round((Date.now() - start) / 1000),
        details: lastDetails,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return {
    status: "timeout",
    durationSec: timeoutSec,
    details: `Last observed status: ${lastStatus}`,
  };
}

// ── Public: create dev library + build ──────────────────────
export async function createDevLibrary(
  input: CreateDevLibraryInput
): Promise<DevLibraryResult> {
  const name = input.libraryName ?? defaultLibraryName();
  const timeoutSec = input.buildTimeoutSeconds ?? 120;

  // Step 1 — Create library tied to the dev environment
  const libBody = {
    data: {
      type: "libraries",
      attributes: { name },
      relationships: {
        environment: {
          data: { id: input.devEnvironmentId, type: "environments" },
        },
      },
    },
  };
  const libResp = await reactorRequest<JsonApiSingleResponse>(
    `/properties/${input.propertyId}/libraries`,
    { method: "POST", body: libBody }
  );
  const libraryId = getId(libResp);

  // Step 2 — Gather HEAD resources (revision_number=0 drafts)
  const heads = await gatherResourceIds(input.propertyId);

  // Step 2b — Revise each head to produce stable revisions. Libraries can
  // only reference revisions, not drafts.
  const revisions = await reviseAllHeads(heads);

  // Step 3 — Attach the revisions to the library
  await addResourcesToLibrary(libraryId, revisions);

  // Step 4 — Trigger build
  const buildBody = jsonApiCreateBody("builds", {});
  const buildResp = await reactorRequest<JsonApiSingleResponse>(
    `/libraries/${libraryId}/builds`,
    { method: "POST", body: buildBody }
  );
  const buildId = getId(buildResp);

  // Step 5 — Poll
  const buildResult = await pollBuild(buildId, timeoutSec);

  // Step 6 — Embed code (regardless of build status — still useful for debugging)
  let embedCode = "";
  let scriptUrl = "";
  try {
    const emb = await getEmbedCode(input.devEnvironmentId);
    embedCode = emb.embed_code;
    scriptUrl = emb.script_url;
  } catch {
    /* leave blank */
  }

  return {
    library_id: libraryId,
    build_id: buildId,
    build_status: buildResult.status,
    build_duration_seconds: buildResult.durationSec,
    embed_code: embedCode,
    script_url: scriptUrl,
    resources_added: {
      extensions: revisions.extensions.length,
      data_elements: revisions.data_elements.length,
      rules: revisions.rules.length,
    },
    failed_details: buildResult.details,
  };
}

// ── Public: get dev library status ──────────────────────────
export interface DevLibraryStatus {
  library_id: string | null;
  library_name: string | null;
  state: string | null;
  last_build: {
    build_id: string;
    status: string;
    built_at?: string;
  } | null;
  resource_counts: { extensions: number; data_elements: number; rules: number };
}

export async function getDevLibraryStatus(
  propertyId: string
): Promise<DevLibraryStatus> {
  // List dev-state libraries (state == "development")
  const libs = await reactorPaginate<{
    name?: string;
    state?: string;
    updated_at?: string;
  }>(`/properties/${propertyId}/libraries`, {
    params: { "filter[state]": "EQ development" },
  });

  if (libs.length === 0) {
    const counts = await gatherResourceIds(propertyId);
    return {
      library_id: null,
      library_name: null,
      state: null,
      last_build: null,
      resource_counts: {
        extensions: counts.extensions.length,
        data_elements: counts.data_elements.length,
        rules: counts.rules.length,
      },
    };
  }

  // Newest first by updated_at if available, otherwise first in list
  libs.sort((a, b) => {
    const au =
      (a.attributes as { updated_at?: string }).updated_at ?? "";
    const bu =
      (b.attributes as { updated_at?: string }).updated_at ?? "";
    return bu.localeCompare(au);
  });
  const lib = libs[0];

  const builds = await reactorPaginate<{
    status?: string;
    created_at?: string;
    updated_at?: string;
  }>(`/libraries/${lib.id}/builds`, {
    params: { "page[size]": 1, sort: "-created_at" },
  });
  const lastBuild = builds[0];

  const counts = await gatherResourceIds(propertyId);

  return {
    library_id: lib.id,
    library_name: (lib.attributes as { name?: string }).name ?? null,
    state: (lib.attributes as { state?: string }).state ?? null,
    last_build: lastBuild
      ? {
          build_id: lastBuild.id,
          status:
            (lastBuild.attributes as { status?: string }).status ?? "unknown",
          built_at:
            (lastBuild.attributes as { updated_at?: string }).updated_at ??
            undefined,
        }
      : null,
    resource_counts: {
      extensions: counts.extensions.length,
      data_elements: counts.data_elements.length,
      rules: counts.rules.length,
    },
  };
}
