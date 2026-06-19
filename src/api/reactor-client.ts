/**
 * Reactor API client (Adobe Experience Platform Launch / Tags).
 *
 * Base URL: https://reactor.adobe.io
 * Wire format: JSON:API 1.0 (Content-Type: application/vnd.api+json,
 *              Accept: application/vnd.api+json;revision=1).
 *
 * This module mirrors the pattern of `target-client.ts` — but Reactor uses
 * JSON:API conventions, different headers, and `attributes.settings` strings
 * that must be JSON-encoded (a hard footgun if you forget).
 *
 * See `Adobe Reactor API docs` §3.2 for the full spec.
 */

import { getAccessToken, clearTokenCache } from "../auth/adobe-ims.js";
import { config } from "../config.js";

// ── Constants ───────────────────────────────────────────────
const REACTOR_BASE = "https://reactor.adobe.io";
const MAX_BODY_LOG_CHARS = 2000;

// ── Types ───────────────────────────────────────────────────
export interface ReactorRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

export interface JsonApiResource<TAttrs = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: TAttrs;
  relationships?: Record<
    string,
    { data: { id: string; type: string } | Array<{ id: string; type: string }> }
  >;
  links?: Record<string, string>;
  meta?: Record<string, unknown>;
}

export interface JsonApiSingleResponse<TAttrs = Record<string, unknown>> {
  data: JsonApiResource<TAttrs>;
  meta?: Record<string, unknown>;
  included?: JsonApiResource[];
}

export interface JsonApiListResponse<TAttrs = Record<string, unknown>> {
  data: Array<JsonApiResource<TAttrs>>;
  meta?: {
    pagination?: {
      current_page: number;
      total_pages: number;
      total_count?: number;
      next_page?: number | null;
      prev_page?: number | null;
    };
    [k: string]: unknown;
  };
  included?: JsonApiResource[];
}

// ── Error extraction ────────────────────────────────────────
/**
 * Reactor returns errors in JSON:API shape:
 *   { "errors": [ { "title": "...", "detail": "...", "source": {...} } ] }
 * Surface as much as we can to the caller — JSON:API error bodies often
 * contain a `source.pointer` field that pinpoints exactly which attribute
 * failed validation (e.g. `/data/attributes/settings`).
 */
function extractReactorError(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const errors = parsed?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors
        .map((e) => {
          const title = e.title ?? "Error";
          const detail = e.detail ?? "";
          const pointer = e?.source?.pointer ? ` [${e.source.pointer}]` : "";
          return `${title}${pointer}: ${detail}`;
        })
        .join("; ");
    }
  } catch {
    /* fall through to raw text */
  }
  return text.slice(0, 400);
}

function formatReactorErr(opts: {
  method: string;
  path: string;
  status: number;
  detail: string;
  url: string;
  body?: unknown;
}): string {
  const lines = [
    `Reactor API ${opts.method} ${opts.path} → ${opts.status}: ${opts.detail}`,
    `  url:     ${opts.url}`,
  ];
  if (opts.body !== undefined && opts.body !== null) {
    let bodyStr: string;
    try {
      bodyStr = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
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

// ── Core request ────────────────────────────────────────────
/**
 * Make an authenticated Reactor API request.
 * - Automatically refreshes the IMS token on 401 and retries ONCE.
 * - Throws on any non-2xx with the JSON:API error detail (including source.pointer).
 */
export async function reactorRequest<T = unknown>(
  path: string,
  options: ReactorRequestOptions = {}
): Promise<T> {
  const { method = "GET", body, params } = options;
  let token = await getAccessToken();

  const url = new URL(`${REACTOR_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const buildHeaders = (tk: string): Record<string, string> => ({
    Authorization: `Bearer ${tk}`,
    "x-api-key": config.ADOBE_CLIENT_ID,
    "x-gw-ims-org-id": config.ADOBE_ORG_ID,
    "Content-Type": "application/vnd.api+json",
    Accept: "application/vnd.api+json;revision=1",
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
      `Network error calling Reactor API ${method} ${url.toString()}: ${(networkErr as Error).message}`
    );
  }

  // Auto-refresh on 401 once
  if (res.status === 401) {
    clearTokenCache();
    token = await getAccessToken();
    res = await doFetch(token);
  }

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      formatReactorErr({
        method,
        path,
        status: res.status,
        detail: extractReactorError(text),
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

// ── Paginate ────────────────────────────────────────────────
/**
 * Walk all pages from a Reactor list endpoint, returning the merged
 * `data` array. Honors any caller-supplied filter/sort params; injects
 * `page[size]` and `page[number]` itself.
 */
export async function reactorPaginate<TAttrs = Record<string, unknown>>(
  path: string,
  options: { params?: Record<string, string | number | boolean | undefined> } = {}
): Promise<Array<JsonApiResource<TAttrs>>> {
  const pageSize = 100;
  const out: Array<JsonApiResource<TAttrs>> = [];
  let currentPage = 1;

  // Hard upper bound to avoid runaway loops on malformed pagination meta.
  const MAX_PAGES = 100;
  while (currentPage <= MAX_PAGES) {
    const params = {
      ...(options.params ?? {}),
      "page[size]": pageSize,
      "page[number]": currentPage,
    };
    const resp = await reactorRequest<JsonApiListResponse<TAttrs>>(path, {
      params,
    });
    if (Array.isArray(resp.data)) out.push(...resp.data);
    const meta = resp.meta?.pagination;
    if (!meta) break;
    const totalPages = meta.total_pages ?? 1;
    if (currentPage >= totalPages) break;
    currentPage += 1;
  }
  return out;
}

// ── JSON:API helpers ────────────────────────────────────────
export function getId(resource: JsonApiSingleResponse | JsonApiResource): string {
  if ("data" in resource) return resource.data.id;
  return resource.id;
}

export function getAttr<T = unknown>(
  resource: JsonApiSingleResponse | JsonApiResource,
  key: string
): T | undefined {
  const attrs =
    "data" in resource ? resource.data.attributes : resource.attributes;
  return (attrs as Record<string, unknown>)?.[key] as T | undefined;
}

export function getRelId(
  resource: JsonApiSingleResponse | JsonApiResource,
  relName: string
): string | undefined {
  const rels =
    "data" in resource ? resource.data.relationships : resource.relationships;
  const rel = rels?.[relName]?.data;
  if (!rel) return undefined;
  if (Array.isArray(rel)) return rel[0]?.id;
  return rel.id;
}

// ── Settings string guard ───────────────────────────────────
/**
 * Reactor's `attributes.settings` field must be a JSON-encoded STRING,
 * not a dict. Forgetting this returns a generic 400 with no useful detail.
 * Run every settings dict through this guard before sending.
 */
export function ensureSettingsString(settings: unknown): string {
  if (typeof settings === "string") {
    // validate parseable so we don't ship garbage
    JSON.parse(settings);
    return settings;
  }
  if (settings && typeof settings === "object") {
    return JSON.stringify(settings);
  }
  throw new Error(
    `Reactor settings must be a JSON-encoded string or an object, got ${typeof settings}`
  );
}

// ── Company ID discovery ────────────────────────────────────
/**
 * The Reactor API does NOT expose `GET /properties` at the root — that route
 * 404s. Properties must be listed under their owning company:
 *     GET /companies/{company_id}/properties
 *
 * Each Adobe Org typically has exactly one Reactor company. We resolve it
 * lazily on first use by calling `GET /companies` and matching on `org_id`,
 * then cache the result in module state.
 */
let cachedCompanyId: string | null = null;

export async function getReactorCompanyId(): Promise<string> {
  if (cachedCompanyId) return cachedCompanyId;

  const companies = await reactorPaginate<{
    name?: string;
    org_id?: string;
  }>("/companies");

  if (companies.length === 0) {
    throw new Error(
      "Reactor returned no companies for this credential. Confirm the Adobe Developer Console integration has the 'Experience Platform Launch' (or 'Adobe Experience Platform Data Collection Tags') API product added."
    );
  }

  // Match by org_id first (most reliable). Fall back to first if none match
  // (single-company orgs sometimes return without org_id populated).
  const { config } = await import("../config.js");
  const match = companies.find(
    (c) => (c.attributes as { org_id?: string }).org_id === config.ADOBE_ORG_ID
  );
  const picked = match ?? companies[0];
  cachedCompanyId = picked.id;
  return cachedCompanyId;
}

export function clearReactorCompanyCache(): void {
  cachedCompanyId = null;
}

// ── JSON:API body builders ──────────────────────────────────
export function jsonApiCreateBody(
  resourceType: string,
  attributes: Record<string, unknown>,
  relationships?: Record<
    string,
    { data: { id: string; type: string } | Array<{ id: string; type: string }> }
  >
): { data: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    type: resourceType,
    attributes,
  };
  if (relationships) body.relationships = relationships;
  return { data: body };
}

export function jsonApiUpdateBody(
  resourceType: string,
  id: string,
  attributes: Record<string, unknown>
): { data: Record<string, unknown> } {
  return {
    data: {
      id,
      type: resourceType,
      attributes,
    },
  };
}
