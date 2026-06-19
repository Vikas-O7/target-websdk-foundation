import { config, IMS_TOKEN_URL } from "../config.js";

// ── Types ───────────────────────────────────────────────────
interface IMSTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
}

// ── Token cache ─────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiresAt = 0; // epoch ms

const BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ── Public: get a valid bearer token ────────────────────────
export async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt - BUFFER_MS) {
    return cachedToken;
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

  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;

  console.error(
    `[auth] Token acquired — expires in ${Math.round(data.expires_in / 60)} min`
  );

  return cachedToken;
}

// ── Public: force-clear the cache (for error recovery) ──────
export function clearTokenCache(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}
