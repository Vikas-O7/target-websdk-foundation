/**
 * Per-request configuration context.
 *
 * In stdio mode (Claude Desktop / Code / Cursor) the MCP server runs as
 * one Node process bound to one tenant's Adobe credentials read from
 * environment variables at boot. Config is effectively static.
 *
 * In HTTP mode (Vercel-hosted for CX Coworker etc.) ONE deployed
 * instance serves many tenants. Each request brings its own Adobe
 * credentials in HTTP headers. We use AsyncLocalStorage to scope those
 * credentials to the async call tree of one request — so the existing
 * API client code (reactor-client, edge-metadata-client, adobe-ims) can
 * keep reading `config.ADOBE_CLIENT_ID` without parameter threading,
 * and each parallel request sees its own values.
 *
 * Stdio mode: AsyncLocalStorage is never populated; `getConfig()` falls
 *             back to the static env-parsed config.
 * HTTP mode:  Each request is wrapped in `runWithContext(...)`; nested
 *             async work transparently reads the right tenant's creds.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestConfig {
  ADOBE_CLIENT_ID: string;
  ADOBE_CLIENT_SECRET: string;
  ADOBE_ORG_ID: string;
  ADOBE_SCOPES: string;
  ADOBE_SANDBOX_NAME: string;
}

const storage = new AsyncLocalStorage<RequestConfig>();

export function runWithRequestConfig<T>(
  ctx: RequestConfig,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return storage.run(ctx, fn);
}

export function getRequestConfig(): RequestConfig | undefined {
  return storage.getStore();
}

// ── Header → context mapping ────────────────────────────────
//
// HTTP mode reads each tenant's Adobe credentials from these custom
// headers. CX Coworker's MCP Server "Headers" config slot is where the
// end user enters them at install time (see docs/cx-coworker-setup.md).
//
// All headers are case-insensitive per HTTP spec; we read them via
// canonical lowercase below.
export const HTTP_HEADER_NAMES = {
  clientId: "x-adobe-client-id",
  clientSecret: "x-adobe-client-secret",
  orgId: "x-adobe-org-id",
  scopes: "x-adobe-scopes",
  sandbox: "x-adobe-sandbox-name",
} as const;

export function configFromHeaders(
  headers: Record<string, string | string[] | undefined>
): { ok: true; config: RequestConfig } | { ok: false; missing: string[] } {
  const get = (name: string): string | undefined => {
    const v = headers[name] ?? headers[name.toUpperCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const clientId = get(HTTP_HEADER_NAMES.clientId);
  const clientSecret = get(HTTP_HEADER_NAMES.clientSecret);
  const orgId = get(HTTP_HEADER_NAMES.orgId);
  const scopes =
    get(HTTP_HEADER_NAMES.scopes) ??
    "openid,AdobeID,read_organizations,additional_info.projectedProductContext,additional_info.roles";
  const sandbox = get(HTTP_HEADER_NAMES.sandbox) ?? "prod";

  const missing: string[] = [];
  if (!clientId) missing.push(HTTP_HEADER_NAMES.clientId);
  if (!clientSecret) missing.push(HTTP_HEADER_NAMES.clientSecret);
  if (!orgId) missing.push(HTTP_HEADER_NAMES.orgId);

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  if (!orgId!.includes("@AdobeOrg")) {
    return {
      ok: false,
      missing: [`${HTTP_HEADER_NAMES.orgId} (must end with @AdobeOrg)`],
    };
  }

  return {
    ok: true,
    config: {
      ADOBE_CLIENT_ID: clientId!,
      ADOBE_CLIENT_SECRET: clientSecret!,
      ADOBE_ORG_ID: orgId!,
      ADOBE_SCOPES: scopes,
      ADOBE_SANDBOX_NAME: sandbox,
    },
  };
}
