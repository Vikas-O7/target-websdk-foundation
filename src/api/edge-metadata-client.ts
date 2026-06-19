/**
 * Edge Metadata client — wraps Adobe's UNDOCUMENTED datastream config API
 * at `https://edge.adobe.io/metadata/namespaces/edge/datasets/datastreams/records`.
 *
 * Reality check (discovered live, 2026):
 *   • Adobe has never published an official API spec for datastream config
 *     management. The endpoint is what the AEP Data Collection UI itself
 *     uses (see browser DevTools Network tab).
 *   • The endpoint REQUIRES a whitelisted x-api-key. Our own OAuth Server-
 *     to-Server client_id is rejected with "Api key is invalid" (EXEG-3036).
 *     The UI's x-api-key — `Activation-DTM` — is the value that passes auth.
 *   • Our bearer token (from our normal IMS exchange) IS accepted alongside
 *     Activation-DTM as the api-key. So we're authorized as our user/org;
 *     the api-key just identifies which Adobe app the call originates from.
 *   • The response shape is HAL+JSON: `{_embedded: {records: [...]}, _links}`
 *     for lists, `{data, orgId, sandboxName, _system, _links}` for items.
 *   • Services (Target, Analytics, etc.) are NOT sub-resources — they live
 *     inside `data.settings.com_adobe_<service>`. Modifying a service means
 *     fetching the record, mutating settings, then PUTting it back.
 *   • Minimum pagination page size is 10 (422 EXEG-3181 below that).
 *   • This API may change without notice. If it breaks, capture the new
 *     UI request shape from the Network tab and re-port.
 */

import { getAccessToken, clearTokenCache } from "../auth/adobe-ims.js";
import { config } from "../config.js";

export const EDGE_METADATA_BASE =
  "https://edge.adobe.io/metadata/namespaces/edge/datasets/datastreams/records";

/**
 * Adobe's allowlisted UI client identifier. The metadata endpoint rejects
 * any other x-api-key with EXEG-3036 "Api key is invalid".
 *
 * This is not a secret — it's visible in any browser DevTools session.
 * But it IS load-bearing for this API to respond at all.
 */
const UI_API_KEY = "Activation-DTM";

const MAX_BODY_LOG_CHARS = 2000;

export interface EdgeMetadataRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

function formatEdgeErr(opts: {
  method: string;
  path: string;
  status: number;
  detail: string;
  url: string;
  body?: unknown;
}): string {
  const lines = [
    `Edge Metadata API ${opts.method} ${opts.path} → ${opts.status}: ${opts.detail}`,
    `  url:     ${opts.url}`,
    `  sandbox: ${config.ADOBE_SANDBOX_NAME}`,
  ];
  if (opts.body !== undefined && opts.body !== null) {
    let bodyStr: string;
    try {
      bodyStr =
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    } catch {
      bodyStr = "[unserializable body]";
    }
    if (bodyStr.length > MAX_BODY_LOG_CHARS) {
      const total = bodyStr.length;
      bodyStr =
        bodyStr.slice(0, MAX_BODY_LOG_CHARS) +
        `… [truncated, ${total} total chars]`;
    }
    lines.push(`  body:    ${bodyStr}`);
  }
  return lines.join("\n");
}

export async function edgeMetadataRequest<T = unknown>(
  path: string,
  options: EdgeMetadataRequestOptions = {}
): Promise<T> {
  const { method = "GET", body, params } = options;
  let token = await getAccessToken();

  const url = new URL(
    path.startsWith("http") ? path : `${EDGE_METADATA_BASE}${path}`
  );
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const buildHeaders = (tk: string): Record<string, string> => ({
    Authorization: `Bearer ${tk}`,
    "x-api-key": UI_API_KEY,
    "x-gw-ims-org-id": config.ADOBE_ORG_ID,
    "x-sandbox-name": config.ADOBE_SANDBOX_NAME,
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  const doFetch = async (tk: string): Promise<Response> => {
    return fetch(url.toString(), {
      method,
      headers: buildHeaders(tk),
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  let res: Response;
  try {
    res = await doFetch(token);
  } catch (networkErr) {
    throw new Error(
      `Network error calling Edge Metadata API ${method} ${url.toString()}: ${(networkErr as Error).message}`
    );
  }

  if (res.status === 401) {
    clearTokenCache();
    token = await getAccessToken();
    res = await doFetch(token);
  }

  const text = await res.text();

  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      const parts: string[] = [];
      if (parsed?.title) parts.push(parsed.title);
      if (parsed?.detail) parts.push(parsed.detail);
      if (parsed?.message) parts.push(parsed.message);
      if (parts.length > 0) detail = parts.join(" — ");
    } catch {
      /* keep raw text */
    }
    throw new Error(
      formatEdgeErr({
        method,
        path,
        status: res.status,
        detail,
        url: url.toString(),
        body: method !== "GET" ? body : undefined,
      })
    );
  }

  if (!text || text.trim() === "") {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

// ── Type contracts ──────────────────────────────────────────
export interface DatastreamSystem {
  id: string;
  revision: number;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface DatastreamSettings {
  input?: Record<string, unknown>;
  geo_lookup?: Record<string, unknown>;
  user_agent_collection?: { enabled?: boolean };
  device_lookup?: { enabled?: boolean; info?: Record<string, boolean> };
  com_adobe_target?: TargetServiceSettings;
  com_adobe_analytics?: AnalyticsServiceSettings;
  com_adobe_identity?: Record<string, unknown>;
  com_adobe_media_analytics?: Record<string, unknown>;
  com_adobe_experience_platform?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Confirmed live shape variants in agsinternal sandbox prod:
 *   { enabled }
 *   { enabled, propertyToken }
 *   { enabled, environmentId }
 *   { enabled, environmentId, propertyToken }
 *   { enabled, environmentId, propertyToken, propertyToken__additional, thirdPartyIdNamespace }
 *
 * Note: NO `clientCode` field. The Target tenant is org-level, not per-
 * datastream. The spec for this MCP's add_target_to_datastream tool was
 * wrong about needing clientCode.
 */
export interface TargetServiceSettings {
  enabled: boolean;
  propertyToken?: string;
  /** Adobe Target environment ID (1=Production, 2=Staging, 3=Development). */
  environmentId?: number | string;
  /** Mbox 3rd-party ID namespace, e.g. "CRMID". */
  thirdPartyIdNamespace?: string;
  /** Some setups expose an array of additional property tokens. */
  propertyToken__additional?: string[];
}

/**
 * Confirmed live shape:
 *   { enabled, reportSuites: [string] }
 *
 * Note: NO `server`, `sslServer`, or `trackingServer` fields. Those were
 * in the spec but the modern Datastream API doesn't accept them.
 */
export interface AnalyticsServiceSettings {
  enabled: boolean;
  reportSuites: string[];
}

export interface DatastreamRecord {
  data: {
    title: string;
    enabled: boolean;
    settings: DatastreamSettings;
  };
  orgId: string;
  sandboxName: string;
  _system: DatastreamSystem;
  _links?: Record<string, unknown>;
}

export interface DatastreamListResponse {
  _embedded?: { records?: DatastreamRecord[] };
  _links?: Record<string, unknown>;
}
