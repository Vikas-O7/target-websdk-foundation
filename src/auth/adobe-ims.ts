import { config, IMS_TOKEN_URL } from "../config.js";

// ── Types ───────────────────────────────────────────────────
interface IMSTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
}

interface CacheEntry {
  token: string;
  expiresAt: number; // epoch ms
}

// ── Token cache (per-tenant, keyed by client_id) ────────────
//
// In stdio mode there's only ever one tenant — cache acts like a
// singleton. In HTTP mode many tenants share one Node process, so the
// cache MUST be keyed by client_id to avoid leaking one tenant's bearer
// token to another tenant's tool calls.
//
// Cache lives only in process memory; never persisted, never logged.
const tokenCache = new Map<string, CacheEntry>();

const BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ── Public: get a valid bearer token for the CURRENT tenant ─
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  const cacheKey = config.ADOBE_CLIENT_ID;
  const cached = tokenCache.get(cacheKey);

  if (cached && now < cached.expiresAt - BUFFER_MS) {
    return cached.token;
  }

  console.error("[auth] Exchanging credentials for IMS access token…");

  const body = new URLSearchParams({
    client_id: config.ADOBE_CLIENT_ID,
    client_secret: config.ADOBE_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: config.ADOBE_SCOPES,
  });

  const res = await fetch(IMS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`IMS token exchange failed (${res.status}): ${errText}`);
  }

  const data: IMSTokenResponse = (await res.json()) as IMSTokenResponse;

  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  });

  console.error(
    `[auth] Token acquired — expires in ${Math.round(data.expires_in / 60)} min`
  );

  return data.access_token;
}

// ── Public: force-clear the cache for the CURRENT tenant ────
//
// Used by API clients on 401 — clears only the offending tenant's
// entry, not the whole multi-tenant cache.
export function clearTokenCache(): void {
  tokenCache.delete(config.ADOBE_CLIENT_ID);
}

// ── For testing / shutdown only ─────────────────────────────
export function clearAllTokenCaches(): void {
  tokenCache.clear();
}
