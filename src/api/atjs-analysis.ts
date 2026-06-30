/**
 * at.js → Web SDK migration analyzer (v1.4).
 *
 * Static-fetch analysis of an existing Adobe Target at.js implementation,
 * scoped to producing the inputs `setup_target_websdk` needs to create the
 * equivalent Web SDK implementation. Complements `discover_site` (which
 * gives a 1-line yes/no for at.js); this tool returns the FULL picture:
 *
 *   • at.js version + CDN host + client code
 *   • parsed `targetGlobalSettings` (permissive JS-object-literal parser)
 *   • mbox catalog (declarative DOM + inline call sites + user-provided)
 *   • prehiding strategy (whole-body vs scoped, raw CSS)
 *   • A4T detection
 *   • at.js setting → Web SDK / Datastream mapping table
 *   • recommended_setup pre-filled for setup_target_websdk
 *
 * Limitations (documented; static fetch only by design):
 *   • Doesn't execute JavaScript. Runtime-injected mboxes/settings invisible.
 *     Consultants augment by passing `knownMboxes` / `targetGlobalSettings`
 *     from a browser inspect.
 *   • Inline-call regex catches obvious `getOffer({mbox:"name"})` and
 *     `mboxCreate("name")`. Sites using helper functions or dynamic mbox
 *     names will look incomplete.
 *   • The settings parser handles object literals with: string values,
 *     number/boolean literals, nested objects, comments, trailing commas,
 *     mixed quoting. It does NOT handle: function expressions, computed
 *     keys, template literals, spread syntax. Unsupported constructs are
 *     dropped with a note in `warnings`.
 *
 * NOT in scope (by design — these belong to Adobe's official Target MCP):
 *   • Activity migration (HTML/JSON offer transformation, audience rules)
 *   • Profile script migration (server-side; stays in Target UI)
 *   • Activity reporting reconciliation
 */

// ── Types ───────────────────────────────────────────────────
export type AtjsVersion = "1.x" | "2.x" | "unknown";
export type PrehidingStyle = "whole-body" | "scoped" | "custom" | "none";

export interface AtjsToWebSdkMapping {
  source: {
    type: "setting" | "mbox" | "prehide";
    key: string;
    value: unknown;
  };
  target: {
    extension: "alloy" | "datastream" | "rule" | "n/a";
    field: string;
    value: unknown;
  };
  confidence: "high" | "medium" | "low";
  reason?: string;
}

export interface AtjsAnalysisReport {
  url: string;
  http_status: number;

  atjs: {
    present: boolean;
    version: AtjsVersion;
    version_evidence: string;
    cdn_host: string | null;
    client_code: string | null;
    library_url: string | null;

    target_global_settings: {
      detected: boolean;
      source: "inline-script" | "tags-bundle" | "user-provided" | "not-found";
      values: Record<string, unknown>;
      unmapped_keys: string[];
    };

    tags_bundle: {
      detected: boolean;
      url: string | null;
      followed: boolean;
      bundle_size_bytes: number | null;
      contained_atjs_markers: boolean;
    };

    mboxes: {
      declarative_dom: string[];
      inline_calls: string[];
      user_provided: string[];
      total_unique: number;
    };

    prehiding: {
      detected: boolean;
      style: PrehidingStyle;
      raw_css: string | null;
      hidden_selectors: string[];
    };

    a4t: {
      detected: boolean;
      tracking_server: string | null;
      note: string;
    };
  };

  migration_plan: {
    auto_mappable: AtjsToWebSdkMapping[];
    manual_review: string[];
    blockers: string[];
  };

  recommended_setup: {
    targetClientCode: string | null;
    flickerSelectors: string[] | null;
    flickerStyle: string | null;
    consentMode: "in" | "pending";
    decisionScopes_default: string[];
    includeA4t: boolean;
    notes: string[];
  };

  warnings: string[];
  summary: string;
}

export interface AnalyzeAtjsInput {
  url: string;
  knownMboxes?: string[];
  targetGlobalSettings?: Record<string, unknown>;
  fetchTimeoutMs?: number;
  /**
   * When true (default), if the inline HTML has a Tags embed but no at.js
   * markers, the analyzer fetches the Tags bundle JS and re-runs extractors
   * against it. Disable for fully-offline analysis or to skip the extra
   * network call when you know at.js is inline.
   */
  followTagsBundle?: boolean;
}

// ── Permissive JS object-literal parser ─────────────────────
/**
 * Find the brace-balanced source of `targetGlobalSettings = { ... }` in
 * the given HTML/JS text. Respects string literals so braces inside
 * strings don't confuse the depth counter. Returns the substring from
 * the opening `{` to its matching `}`, or null if not found.
 */
function findSettingsBlock(text: string): string | null {
  const m = /(?:window\.)?targetGlobalSettings\s*=\s*(\{)/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inString: false | "'" | '"' | "`" = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
      } else if (c === inString) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Convert a JS object literal source to JSON, handling: comments,
 * single-quoted strings, unquoted keys, trailing commas. Returns null
 * if the result still won't parse (caller falls back to regex extraction).
 *
 * Deliberately conservative — bails out cleanly instead of producing
 * malformed JSON on edge cases. Tested patterns:
 *   • { key: "val", other: 1234, flag: true }
 *   • { key: 'val' }
 *   • { /* block * / key: "val", // line
 *       other: "x", }
 *   • { nested: { a: 1, b: 2 } }
 */
function objectLiteralToJson(src: string): string | null {
  // Strip line + block comments. Respect strings while doing so.
  let s = "";
  let inString: false | "'" | '"' | "`" = false;
  let escape = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (escape) {
      escape = false;
      s += c;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === inString) inString = false;
      s += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      s += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/"))
        i++;
      i++;
      continue;
    }
    s += c;
  }

  // Convert single-quoted strings to double-quoted, JSON-escaping the body.
  // Skip when we're inside a double-quoted string already.
  let out = "";
  inString = false;
  escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      out += c;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
        out += c;
        continue;
      }
      if (c === inString) {
        inString = false;
        if (c === "'" || c === "`") out += '"';
        else out += c;
        continue;
      }
      // Inside a string: characters pass through. If we converted the
      // opening quote, must also escape any embedded double-quotes.
      if ((inString as string) !== '"' && c === '"') {
        out += '\\"';
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      if (c === "'" || c === "`") out += '"';
      else out += c;
      continue;
    }
    out += c;
  }
  s = out;

  // Quote unquoted keys + strip trailing commas — but ONLY outside string
  // literals. A naive global regex would mangle string contents like
  // `bodyHiddenStyle:"body {opacity: 0}"` (matches `opacity:` as a key
  // even though it's inside the string).
  s = transformOutsideStrings(s, (chunk) =>
    chunk
      .replace(
        /([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g,
        (_m, prefix, key) => `${prefix}"${key}":`
      )
      .replace(/,(\s*[}\]])/g, "$1")
  );

  // Validate parseable; if not, return null
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

/**
 * Apply `transform` only to runs of characters that are outside any
 * string literal (single, double, or template-quoted). The transform
 * receives one contiguous out-of-string segment at a time.
 */
function transformOutsideStrings(
  src: string,
  transform: (chunk: string) => string
): string {
  let out = "";
  let buffer = "";
  let inString: false | "'" | '"' | "`" = false;
  let escape = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (escape) {
      escape = false;
      if (inString) out += c;
      else buffer += c;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
        out += c;
        continue;
      }
      if (c === inString) {
        out += c;
        inString = false;
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // Flush buffer through transform, then emit the opening quote.
      out += transform(buffer);
      buffer = "";
      out += c;
      inString = c;
      continue;
    }
    buffer += c;
  }
  out += transform(buffer);
  return out;
}

function parseTargetGlobalSettings(
  html: string
): { values: Record<string, unknown>; raw: string } | null {
  const block = findSettingsBlock(html);
  if (!block) return null;
  const json = objectLiteralToJson(block);
  if (!json) return null;
  try {
    const values = JSON.parse(json) as Record<string, unknown>;
    return { values, raw: block };
  } catch {
    return null;
  }
}

// ── Extractors ──────────────────────────────────────────────
const ATJS_SCRIPT_PATTERNS: Array<{ pattern: RegExp; version: AtjsVersion }> = [
  { pattern: /at\.js-(2\.\d+(?:\.\d+)?)/, version: "2.x" },
  { pattern: /at\.js-(1\.\d+(?:\.\d+)?)/, version: "1.x" },
  { pattern: /at\.js-(\d+\.\d+(?:\.\d+)?)/, version: "unknown" },
];

const ATJS_BARE_PATTERNS = [
  /["']at\.js["']/i,
  /adobe\.target\.(init|getOffer|applyOffer|trackEvent|registerExtension)/,
  /(?:^|[^a-zA-Z])mboxCreate\s*\(/,
  /(?:^|[^a-zA-Z])mboxDefine\s*\(/,
  /(?:^|[^a-zA-Z])mboxUpdate\s*\(/,
];

function classifyVersionMajor(verString: string): AtjsVersion {
  const major = parseInt(verString.split(".")[0] ?? "0", 10);
  if (major === 2) return "2.x";
  if (major === 1) return "1.x";
  return "unknown";
}

/**
 * Find and parse the Reactor at.js extension's `targetSettings:{...}` block
 * embedded in a Tags bundle. This is a separate parser from the
 * `targetGlobalSettings = {...}` one used on inline HTML — the Tags bundle
 * uses minified property/colon syntax (`targetSettings:{enabled:!0,...}`)
 * which the permissive object-literal parser can decode after light
 * fix-up of the `!0`/`!1` boolean shorthand.
 */
function findTargetSettingsBlock(text: string): string | null {
  const m = /\btargetSettings\s*:\s*(\{)/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inString: false | "'" | '"' | "`" = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === inString) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseTargetSettingsFromBundle(
  text: string
): Record<string, unknown> | null {
  const block = findTargetSettingsBlock(text);
  if (!block) return null;
  // Minified bundles use `!0`/`!1` for true/false. Pre-process before
  // passing to the JSON converter — but only outside string contexts.
  const noShorthand = replaceBooleanShorthand(block);
  const json = objectLiteralToJson(noShorthand);
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Replace minified `!0` → `true` and `!1` → `false` outside string
 * contexts. Tags bundles use these shorthands heavily.
 */
function replaceBooleanShorthand(src: string): string {
  let out = "";
  let inString: false | "'" | '"' | "`" = false;
  let escape = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (escape) {
      escape = false;
      out += c;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === inString) inString = false;
      out += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      continue;
    }
    if (c === "!" && (src[i + 1] === "0" || src[i + 1] === "1")) {
      out += src[i + 1] === "0" ? "true" : "false";
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function extractAtjsVersion(text: string): {
  version: AtjsVersion;
  evidence: string;
  libraryUrl: string | null;
} {
  // Pattern 1 — versioned filename in a <script src>:
  //   <script src="//cdn.tt.omtrdc.net/.../at.js-2.11.2.min.js">
  for (const { pattern, version } of ATJS_SCRIPT_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const ver = m[1];
      const urlPattern = new RegExp(
        `([^"'\\s>]*at\\.js-${ver.replace(/\./g, "\\.")}[^"'\\s>]*)`,
        "i"
      );
      const urlMatch = urlPattern.exec(text);
      return {
        version,
        evidence: `Filename match: at.js-${ver}`,
        libraryUrl: urlMatch ? urlMatch[1] : null,
      };
    }
  }
  // Pattern 2 — Reactor extension package marker. The at.js 2.x Tags
  // extension lives under `adobe-target-v2/lib/...`; the legacy at.js 1.x
  // extension is `adobe-target/lib/...` (no -v2). Most reliable signal in
  // a Tags-built bundle.
  if (/\badobe-target-v2\//.test(text)) {
    const verLit = parseTargetSettingsFromBundle(text)?.version;
    const versionStr = typeof verLit === "string" ? verLit : null;
    return {
      version: "2.x",
      evidence: versionStr
        ? `Reactor extension adobe-target-v2 with version literal ${versionStr}`
        : "Reactor extension adobe-target-v2 (at.js 2.x)",
      libraryUrl: null,
    };
  }
  if (/\badobe-target\//.test(text) && !/adobe-target-v2/.test(text)) {
    return {
      version: "1.x",
      evidence: "Reactor extension adobe-target (at.js 1.x, no -v2 suffix)",
      libraryUrl: null,
    };
  }
  // Pattern 3 — version literal near an at.js token (proximity-based).
  const proximity = /at\.js[\s\S]{0,1200}?\bversion\b\s*[:=]\s*["'](\d+\.\d+(?:\.\d+)?)/.exec(
    text
  );
  if (proximity) {
    const ver = proximity[1];
    return {
      version: classifyVersionMajor(ver),
      evidence: `Version literal near at.js token: ${ver}`,
      libraryUrl: null,
    };
  }
  // Pattern 4 — bare API presence
  if (ATJS_BARE_PATTERNS.some((p) => p.test(text))) {
    return {
      version: "unknown",
      evidence: "at.js API references found but no version literal",
      libraryUrl: null,
    };
  }
  return { version: "unknown", evidence: "no at.js markers", libraryUrl: null };
}

const TAGS_BUNDLE_PATTERN =
  /src=["']((?:https?:)?\/\/assets\.adobedtm\.com\/[^"']+\.js)["']/i;

function extractTagsBundleUrl(html: string): string | null {
  const m = TAGS_BUNDLE_PATTERN.exec(html);
  if (!m) return null;
  let url = m[1];
  if (url.startsWith("//")) url = `https:${url}`;
  return url;
}

async function fetchTagsBundle(
  url: string,
  timeoutMs: number
): Promise<{ text: string; sizeBytes: number } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (target-websdk-foundation analyze_atjs_implementation)",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const text = await res.text();
    return { text, sizeBytes: text.length };
  } catch {
    return null;
  }
}

function extractCdnHost(libraryUrl: string | null): string | null {
  if (!libraryUrl) return null;
  try {
    const u = new URL(
      libraryUrl.startsWith("//") ? `https:${libraryUrl}` : libraryUrl
    );
    return u.hostname;
  } catch {
    return null;
  }
}

// Subdomains of `tt.omtrdc.net` that are NEVER a client code (Adobe-owned
// CDN/edge infrastructure). Real client codes are tenant-specific strings.
const NON_CLIENT_TT_SUBDOMAINS = new Set([
  "cdn",
  "www",
  "m",
  "edge",
  "secure",
  "tt",
]);

function extractClientCode(
  text: string,
  libraryUrl: string | null,
  settings: Record<string, unknown> | null
): string | null {
  // Priority 1: settings dict (highest fidelity when we parsed it)
  if (settings && typeof settings.clientCode === "string") {
    return settings.clientCode;
  }
  // Priority 2: explicit `clientCode:"..."` literal anywhere in the text.
  // In Tags bundles this is the most reliable signal — the at.js extension
  // emits the property's client code as a string constant.
  const literalMatch = /clientCode\s*[:=]\s*["']([a-zA-Z0-9_-]+)["']/.exec(
    text
  );
  if (literalMatch) return literalMatch[1];
  // Priority 3: subdomain pattern `://CLIENTCODE.tt.omtrdc.net` — the
  // Target Edge endpoint for this tenant. Excludes Adobe's own infra
  // subdomains (cdn, www, etc.) which would otherwise false-positive.
  const subRe = /:\/\/([a-zA-Z0-9_-]+)\.tt\.omtrdc\.net/gi;
  let m: RegExpExecArray | null;
  while ((m = subRe.exec(text)) !== null) {
    const sub = m[1].toLowerCase();
    if (!NON_CLIENT_TT_SUBDOMAINS.has(sub)) return m[1];
  }
  // Priority 4: legacy at.js 1.x path `tt.omtrdc.net/CLIENTCODE/...` from
  // a library URL (the at.js 1.x library was sometimes served from there).
  if (libraryUrl) {
    const pathMatch = /tt\.omtrdc\.net\/([a-zA-Z0-9_-]+)\//i.exec(libraryUrl);
    if (pathMatch && !["at", "atjs"].includes(pathMatch[1].toLowerCase())) {
      return pathMatch[1];
    }
  }
  return null;
}

function extractDeclarativeMboxes(html: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /<[^>]+\bmbox\s*=\s*["']([^"']+)["']/g,
    /<[^>]+\bdata-mbox\s*=\s*["']([^"']+)["']/g,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(html)) !== null) {
      if (m[1] && m[1] !== "target-global-mbox") found.add(m[1]);
    }
  }
  return Array.from(found).sort();
}

function extractInlineMboxes(html: string): string[] {
  const found = new Set<string>();
  // mboxCreate("name"), mboxDefine("id", "name"), mboxUpdate("name", ...)
  const mboxCreateRe = /mboxCreate\s*\(\s*["']([^"']+)["']/g;
  const mboxDefineRe =
    /mboxDefine\s*\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g;
  const mboxUpdateRe = /mboxUpdate\s*\(\s*["']([^"']+)["']/g;
  // getOffer({mbox: "name"}) — order-tolerant
  const getOfferRe = /getOffer\s*\(\s*\{[^}]*\bmbox\s*:\s*["']([^"']+)["']/g;
  // applyOffer({mbox: "name"})
  const applyOfferRe = /applyOffer\s*\(\s*\{[^}]*\bmbox\s*:\s*["']([^"']+)["']/g;

  for (const re of [
    mboxCreateRe,
    mboxDefineRe,
    mboxUpdateRe,
    getOfferRe,
    applyOfferRe,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) found.add(m[1]);
    }
  }
  return Array.from(found).sort();
}

function extractPrehiding(html: string): {
  detected: boolean;
  style: PrehidingStyle;
  raw_css: string | null;
  hidden_selectors: string[];
} {
  // at.js 2.x default: #atomBox / .at-element-marker
  // at.js 1.x default: body { opacity: 0 }
  // Custom: any rule referencing these classes or aliasing them
  const stylePatterns = [
    /<style[^>]*>([\s\S]*?at-element-marker[\s\S]*?)<\/style>/i,
    /<style[^>]*>([\s\S]*?atomBox[\s\S]*?)<\/style>/i,
    /<style[^>]*>([\s\S]*?#mbox[\s\S]*?)<\/style>/i,
    /<style[^>]*>([\s\S]*?body\s*\{\s*opacity\s*:\s*0[\s\S]*?)<\/style>/i,
  ];
  for (const p of stylePatterns) {
    const m = p.exec(html);
    if (m) {
      const css = m[1].trim();
      // Heuristic: whole-body prehide vs scoped
      if (/body\s*\{[^}]*opacity\s*:\s*0/.test(css)) {
        return {
          detected: true,
          style: "whole-body",
          raw_css: css,
          hidden_selectors: ["body"],
        };
      }
      // Extract selectors from the CSS rules
      const selectors = new Set<string>();
      const selectorRe = /([^{}]+)\{[^}]*\}/g;
      let sm: RegExpExecArray | null;
      while ((sm = selectorRe.exec(css)) !== null) {
        const sel = sm[1].trim();
        if (sel && !sel.startsWith("@")) selectors.add(sel);
      }
      return {
        detected: true,
        style: "scoped",
        raw_css: css,
        hidden_selectors: Array.from(selectors),
      };
    }
  }
  return {
    detected: false,
    style: "none",
    raw_css: null,
    hidden_selectors: [],
  };
}

function extractA4t(
  html: string,
  settings: Record<string, unknown> | null
): { detected: boolean; tracking_server: string | null; note: string } {
  // A4T signals:
  //  - `trackingServer` key in targetGlobalSettings
  //  - presence of AppMeasurement (`s_code.js`, `AppMeasurement.js`, `s.t()`)
  //  - `s_objectID` references near getOffer/applyOffer
  let trackingServer: string | null = null;
  if (
    settings &&
    typeof settings.trackingServer === "string" &&
    settings.trackingServer
  ) {
    trackingServer = settings.trackingServer as string;
  }
  const hasAppMeasurement = /AppMeasurement|s_code\.js|\bs\.t\(\)/.test(html);
  const hasSObjectId = /\bs_objectID\b/.test(html);

  const detected =
    !!trackingServer || (hasAppMeasurement && hasSObjectId);
  let note = "";
  if (detected) {
    note =
      "A4T (Analytics for Target) indicators present. Migrating A4T to Web SDK requires the Datastream's Analytics service wired with the same report suite(s) the site currently uses — call add_analytics_to_datastream with reportSuites + trackingServer. The MCP cannot infer the report suite ID from HTML; capture it from your AppMeasurement config or Tags property.";
  } else if (hasAppMeasurement) {
    note =
      "Adobe Analytics detected but no s_objectID linkage to Target found. Likely AA-only (no A4T). If you want A4T after migration, set includeA4t: true on setup_target_websdk.";
  } else {
    note =
      "No A4T indicators. setup_target_websdk's default includeA4t: false is correct unless Analytics will be added separately.";
  }
  return { detected, tracking_server: trackingServer, note };
}

// ── Setting → Web SDK / Datastream map ──────────────────────
interface SettingMapEntry {
  source_key: string;
  target: AtjsToWebSdkMapping["target"];
  confidence: AtjsToWebSdkMapping["confidence"];
  reason?: string;
  transform?: (v: unknown) => unknown;
}

const SETTING_MAP: SettingMapEntry[] = [
  {
    source_key: "clientCode",
    target: {
      extension: "datastream",
      field: "targetService.clientCode",
      value: null,
    },
    confidence: "high",
    reason:
      "Datastream's Target service is wired with the same client code.",
    transform: (v) => v,
  },
  {
    source_key: "timeout",
    target: { extension: "alloy", field: "personalization.timeout", value: null },
    confidence: "high",
    reason:
      "alloy personalization.timeout uses ms; copy directly. Web SDK caps at 3000ms practically.",
    transform: (v) => v,
  },
  {
    source_key: "defaultContentHiddenStyle",
    target: { extension: "alloy", field: "flickerStyle (orchestrator)", value: null },
    confidence: "high",
    reason:
      "Pass to setup_target_websdk's flickerStyle param. Best practice: convert to flickerSelectors scoped to specific containers.",
    transform: (v) => v,
  },
  {
    source_key: "bodyHiddenStyle",
    target: { extension: "alloy", field: "flickerStyle (orchestrator)", value: null },
    confidence: "medium",
    reason:
      "at.js whole-body prehide rule. Web SDK supports the same via flickerStyle, but best practice is to scope to specific containers (flickerSelectors) — whole-body prehiding causes a blank-page failure mode during Edge response time.",
    transform: (v) => v,
  },
  {
    source_key: "optoutEnabled",
    target: { extension: "alloy", field: "consentMode (orchestrator)", value: null },
    confidence: "medium",
    reason:
      "optoutEnabled:true → consentMode:'pending' + a Set Consent rule. Requires a CMP wired to dispatch the consent grant.",
    transform: (v) => (v === true ? "pending" : "in"),
  },
  {
    source_key: "trackingServer",
    target: { extension: "datastream", field: "analyticsService.trackingServer", value: null },
    confidence: "high",
    reason:
      "Pass to add_analytics_to_datastream's trackingServer param. Only relevant when includeA4t:true.",
    transform: (v) => v,
  },
  {
    source_key: "serverDomain",
    target: { extension: "n/a", field: "—", value: null },
    confidence: "medium",
    reason:
      "Edge Network replaces tt.omtrdc.net routing. Drops — no equivalent setting needed.",
    transform: () => "(dropped — Edge Network handles routing)",
  },
  {
    source_key: "overrideMboxEdgeServer",
    target: { extension: "n/a", field: "—", value: null },
    confidence: "high",
    reason: "No equivalent in Web SDK. Drop.",
    transform: () => "(dropped)",
  },
  {
    source_key: "mboxPath",
    target: { extension: "n/a", field: "—", value: null },
    confidence: "high",
    reason: "Web SDK uses a single Edge endpoint. Drop.",
    transform: () => "(dropped)",
  },
  {
    source_key: "pageLoadEnabled",
    target: { extension: "n/a", field: "—", value: null },
    confidence: "high",
    reason:
      "Web SDK's sendEvent on the page-load rule replaces this. Drop.",
    transform: () => "(replaced by Web SDK page-load rule)",
  },
  {
    source_key: "viewsEnabled",
    target: { extension: "alloy", field: "decisionScopes (rule)", value: null },
    confidence: "low",
    reason:
      "at.js views → XDM view scopes on sendEvent. Requires per-view rule architecture; consultant decision.",
    transform: (v) => v,
  },
  {
    source_key: "cookieDomain",
    target: { extension: "alloy", field: "edgeDomain / cookie behavior", value: null },
    confidence: "low",
    reason:
      "Web SDK first-party cookies use the page domain by default. Different semantic — review whether the at.js value needs preserving (sub-domain scenarios).",
    transform: (v) => v,
  },
  {
    source_key: "crossDomain",
    target: { extension: "alloy", field: "identityMigration.aep (mode)", value: null },
    confidence: "low",
    reason:
      "at.js crossDomain stitching → Web SDK ECID propagation. Architectural — flag for consultant review.",
    transform: (v) => v,
  },
  {
    source_key: "secureOnly",
    target: { extension: "alloy", field: "edgeDomain (https)", value: null },
    confidence: "medium",
    reason:
      "Web SDK is HTTPS-only by default; this setting drops naturally.",
    transform: () => "(implicit in Web SDK)",
  },
];

function mapSettingsToWebSdk(
  settings: Record<string, unknown>
): { mappings: AtjsToWebSdkMapping[]; unmapped: string[] } {
  const knownKeys = new Set(SETTING_MAP.map((e) => e.source_key));
  const mappings: AtjsToWebSdkMapping[] = [];
  for (const entry of SETTING_MAP) {
    if (!(entry.source_key in settings)) continue;
    const sourceValue = settings[entry.source_key];
    const mappedValue = entry.transform
      ? entry.transform(sourceValue)
      : sourceValue;
    mappings.push({
      source: { type: "setting", key: entry.source_key, value: sourceValue },
      target: { ...entry.target, value: mappedValue },
      confidence: entry.confidence,
      reason: entry.reason,
    });
  }
  const unmapped = Object.keys(settings).filter((k) => !knownKeys.has(k));
  return { mappings, unmapped };
}

// ── Public analyzer ─────────────────────────────────────────
export async function analyzeAtjsImplementation(
  input: AnalyzeAtjsInput
): Promise<AtjsAnalysisReport> {
  const warnings: string[] = [];

  // Fetch HTML
  let html = "";
  let httpStatus = 0;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      input.fetchTimeoutMs ?? 10000
    );
    const res = await fetch(input.url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (target-websdk-foundation analyze_atjs_implementation)",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    httpStatus = res.status;
    html = await res.text();
    if (!res.ok) {
      warnings.push(
        `HTTP ${res.status} — analysis ran against a non-2xx response; signals may be unreliable.`
      );
    }
  } catch (e) {
    return emptyReport(input.url, [
      `Could not fetch ${input.url}: ${(e as Error).message}`,
    ]);
  }

  // Tags bundle detection — Adobe Tags (Launch) wraps at.js inside an
  // async-loaded JS bundle. Static fetch of the page sees only the embed
  // script tag, not the at.js detail. When no inline at.js markers are
  // present BUT a Tags embed is, follow the bundle URL and re-run
  // extractors against the bundle text. Real-world enterprise sites
  // (paloaltonetworks, hpe, hundreds more) almost always look like this.
  const tagsBundleUrl = extractTagsBundleUrl(html);
  let bundleText = "";
  let bundleFollowed = false;
  let bundleSizeBytes: number | null = null;
  let bundleHadAtjsMarkers = false;

  const atjsInHtml =
    /at\.js-(\d+\.\d+(?:\.\d+)?)|adobe\.target\.(init|getOffer|applyOffer|registerExtension)|(?:^|[^a-zA-Z])mboxCreate\s*\(|targetGlobalSettings\s*=/.test(
      html
    );

  if (
    !atjsInHtml &&
    tagsBundleUrl &&
    input.followTagsBundle !== false
  ) {
    const bundleTimeout = input.fetchTimeoutMs ?? 10000;
    const bundle = await fetchTagsBundle(tagsBundleUrl, bundleTimeout);
    if (bundle) {
      bundleText = bundle.text;
      bundleFollowed = true;
      bundleSizeBytes = bundle.sizeBytes;
      bundleHadAtjsMarkers =
        /at\.js|adobe\.target\.(init|getOffer|applyOffer)|mboxCreate|targetGlobalSettings/.test(
          bundleText
        );
    } else {
      warnings.push(
        `Tags bundle detected at ${tagsBundleUrl} but follow-fetch failed (network or non-2xx). At.js detail inside the bundle could not be analyzed.`
      );
    }
  }

  // Haystack = combined source-of-truth for all extractors. HTML first
  // (so DOM extractors that look for `<style>` etc. see the right
  // context); bundle JS concatenated after for settings/mbox parsing.
  const haystack = bundleText ? `${html}\n\n/* TAGS_BUNDLE */\n${bundleText}` : html;

  // at.js presence + version (run against haystack — catches bundled at.js)
  const versionInfo = extractAtjsVersion(haystack);
  const cdnHost = extractCdnHost(versionInfo.libraryUrl);
  const atjsPresent =
    versionInfo.version !== "unknown" ||
    /at\.js|mboxCreate|adobe\.target\.(init|getOffer)/.test(haystack);

  if (!atjsPresent && !input.targetGlobalSettings) {
    const noAtjsWarnings = [...warnings];
    if (tagsBundleUrl && !bundleFollowed) {
      noAtjsWarnings.push(
        "A Tags embed was present but the bundle couldn't be fetched. If you know the site is on at.js, retry with a longer fetchTimeoutMs or check network access."
      );
    } else if (tagsBundleUrl && bundleFollowed && !bundleHadAtjsMarkers) {
      noAtjsWarnings.push(
        "A Tags bundle was followed but contained no at.js markers. The site appears to be on Web SDK (alloy) already, OR the Target extension isn't part of this Tags property."
      );
    } else {
      noAtjsWarnings.push(
        "No at.js markers found in the served HTML and no targetGlobalSettings provided. This page likely isn't running at.js — verify the URL or fetch a known at.js page."
      );
    }
    const empty = emptyReport(input.url, noAtjsWarnings);
    empty.http_status = httpStatus;
    empty.atjs.tags_bundle = {
      detected: !!tagsBundleUrl,
      url: tagsBundleUrl,
      followed: bundleFollowed,
      bundle_size_bytes: bundleSizeBytes,
      contained_atjs_markers: bundleHadAtjsMarkers,
    };
    return empty;
  }

  // Settings — try three sources in order:
  //   1. Inline `targetGlobalSettings = {...}` in served HTML
  //   2. `targetGlobalSettings = {...}` inside the Tags bundle (rare)
  //   3. Reactor at.js extension `targetSettings:{...}` in the Tags bundle
  // User-provided always merges on top and wins.
  let parsed = parseTargetGlobalSettings(html);
  let settingsSource: "inline-script" | "tags-bundle" | "user-provided" | "not-found" =
    parsed ? "inline-script" : "not-found";
  if (!parsed && bundleText) {
    parsed = parseTargetGlobalSettings(bundleText);
    if (parsed) settingsSource = "tags-bundle";
  }
  let settingsValues: Record<string, unknown> = parsed ? parsed.values : {};
  // Layer in the Reactor extension's `targetSettings:{...}` block — gives
  // us clientCode, timeout, optoutEnabled, etc. from minified bundles
  // where `targetGlobalSettings` isn't expressed as an inline assignment.
  if (bundleText) {
    const extSettings = parseTargetSettingsFromBundle(bundleText);
    if (extSettings) {
      // Normalize: timeout is often a string in the extension settings
      const normalized: Record<string, unknown> = { ...extSettings };
      if (typeof normalized.timeout === "string") {
        const n = parseInt(normalized.timeout, 10);
        if (!Number.isNaN(n)) normalized.timeout = n;
      }
      // Existing parsed values win (more authoritative if `targetGlobalSettings`
      // was found as a literal); fill in gaps from the extension settings.
      settingsValues = { ...normalized, ...settingsValues };
      if (settingsSource === "not-found") settingsSource = "tags-bundle";
    }
  }
  if (input.targetGlobalSettings) {
    settingsValues = { ...settingsValues, ...input.targetGlobalSettings };
    if (settingsSource === "not-found") settingsSource = "user-provided";
  }
  if (
    settingsSource === "not-found" &&
    !input.targetGlobalSettings &&
    atjsPresent
  ) {
    warnings.push(
      "targetGlobalSettings not found in served HTML or Tags bundle. Some sites set it via a build pipeline or runtime config fetch — capture from browser console (`window.targetGlobalSettings`) and pass via targetGlobalSettings for a complete report."
    );
  }

  // Client code (search haystack so bundle clientCode is found)
  const clientCode = extractClientCode(haystack, versionInfo.libraryUrl, parsed?.values ?? null);

  // Mboxes — declarative DOM is HTML-only (DOM context); inline calls
  // could be in either source.
  const declarative = extractDeclarativeMboxes(html);
  const inlineCalls = extractInlineMboxes(haystack);
  const userMboxes = (input.knownMboxes ?? []).filter(
    (m) => typeof m === "string" && m.length > 0
  );
  const allMboxes = new Set([...declarative, ...inlineCalls, ...userMboxes]);
  if (
    atjsPresent &&
    declarative.length === 0 &&
    inlineCalls.length === 0 &&
    userMboxes.length === 0
  ) {
    warnings.push(
      "No mbox names found via static analysis (HTML or Tags bundle). at.js sites typically register mboxes via JS at runtime — capture the mbox list from a network trace (search for 'tt.omtrdc.net/m2' requests) and pass via knownMboxes for a complete report."
    );
  }

  // Prehiding — first look at HTML <style> blocks. If nothing found there
  // AND the bundle settings expose a `bodyHiddenStyle` rule with
  // `bodyHidingEnabled: true`, synthesize a whole-body prehide finding —
  // that's at.js's default behavior when the consultant didn't override it.
  let prehiding = extractPrehiding(html);
  if (
    !prehiding.detected &&
    typeof settingsValues.bodyHiddenStyle === "string" &&
    settingsValues.bodyHidingEnabled !== false
  ) {
    const css = settingsValues.bodyHiddenStyle as string;
    const isWholeBody = /body\s*\{/.test(css);
    prehiding = {
      detected: true,
      style: isWholeBody ? "whole-body" : "custom",
      raw_css: css,
      hidden_selectors: isWholeBody ? ["body"] : [],
    };
  }

  // A4T — search haystack so bundle tracking_server is found
  const a4t = extractA4t(haystack, parsed?.values ?? settingsValues);

  // Mapping
  const { mappings, unmapped } = mapSettingsToWebSdk(settingsValues);

  // Compose migration plan
  const manualReview: string[] = [];
  const blockers: string[] = [];

  if (versionInfo.version === "1.x") {
    blockers.push(
      "at.js 1.x detected. Adobe ended support for at.js 1.x in 2024-12. Web SDK migration requires the site to be on at.js 2.x OR a clean cutover. Recommend cutover via setup_target_websdk + parallel verification rather than a transition phase."
    );
  }
  if (
    prehiding.detected &&
    prehiding.style === "whole-body"
  ) {
    manualReview.push(
      "Whole-body prehiding detected. Web SDK's flickerSelectors with scoped containers is the senior-consultant best practice — saves the blank-page failure mode during Edge response. Identify the actual personalization containers and pass them as flickerSelectors."
    );
  }
  if (a4t.detected && !a4t.tracking_server) {
    manualReview.push(
      "A4T detected but trackingServer not extracted. Pull it from AppMeasurement's `s.trackingServer` and pass to add_analytics_to_datastream after setup_target_websdk."
    );
  }
  if (allMboxes.size > 0) {
    manualReview.push(
      `${allMboxes.size} mbox(es) detected. Each at.js mbox maps to a Web SDK 'decisionScope'. Decide per-mbox: (a) keep as scope name 1:1 (simplest), (b) consolidate into XDM view scopes (cleaner long-term), or (c) drop the mbox if its activity is no longer needed.`
    );
  }
  for (const m of mappings) {
    if (m.confidence === "low") {
      manualReview.push(
        `${m.source.key}: ${m.reason ?? "Manual review required."}`
      );
    }
  }

  // Recommended setup pre-fill
  let consentMode: "in" | "pending" = "in";
  const consentMap = mappings.find((m) => m.source.key === "optoutEnabled");
  if (consentMap && consentMap.target.value === "pending") consentMode = "pending";

  let flickerStyle: string | null = null;
  let flickerSelectors: string[] | null = null;
  if (prehiding.detected) {
    if (prehiding.style === "scoped" && prehiding.hidden_selectors.length > 0) {
      flickerSelectors = prehiding.hidden_selectors;
    } else if (prehiding.raw_css) {
      flickerStyle = prehiding.raw_css;
    }
  }

  const notes: string[] = [];
  if (versionInfo.version === "1.x") {
    notes.push(
      "at.js 1.x → Web SDK is a clean-cutover migration. Stand up the new Web SDK property first; deploy on a single test page; verify in dev; then flip the embed when verified."
    );
  }
  if (versionInfo.version === "2.x") {
    notes.push(
      "at.js 2.x can run in parallel with Web SDK during migration via Web SDK's targetMigrationEnabled flag. Useful for incremental cutover on large sites."
    );
  }
  if (allMboxes.size > 0) {
    notes.push(
      `Pre-filled decisionScopes_default with ${allMboxes.size} mbox(es). Pass these to setup_target_websdk via a custom pageLoadConditions/rule or set them as scopes on the alloy.sendEvent call.`
    );
  }
  if (a4t.detected) {
    notes.push(a4t.note);
  }
  if (unmapped.length > 0) {
    notes.push(
      `${unmapped.length} targetGlobalSettings key(s) have no Web SDK equivalent and were not auto-mapped: ${unmapped.join(", ")}. Most are safe to drop — review each.`
    );
  }

  // Summary
  const parts = [
    `at.js ${versionInfo.version}`,
    clientCode ? `client=${clientCode}` : null,
    `${allMboxes.size} mbox${allMboxes.size === 1 ? "" : "es"}`,
    prehiding.detected ? `prehide=${prehiding.style}` : null,
    a4t.detected ? "A4T detected" : null,
    `${mappings.length} settings mappable, ${unmapped.length} unmapped`,
    blockers.length > 0
      ? `${blockers.length} blocker(s)`
      : `${manualReview.length} manual review item(s)`,
  ].filter(Boolean);
  const summary = parts.join(" · ");

  return {
    url: input.url,
    http_status: httpStatus,
    atjs: {
      present: atjsPresent,
      version: versionInfo.version,
      version_evidence: versionInfo.evidence,
      cdn_host: cdnHost,
      client_code: clientCode,
      library_url: versionInfo.libraryUrl,
      target_global_settings: {
        detected: settingsSource !== "not-found",
        source: settingsSource,
        values: settingsValues,
        unmapped_keys: unmapped,
      },
      mboxes: {
        declarative_dom: declarative,
        inline_calls: inlineCalls,
        user_provided: userMboxes,
        total_unique: allMboxes.size,
      },
      prehiding,
      a4t,
      tags_bundle: {
        detected: !!tagsBundleUrl,
        url: tagsBundleUrl,
        followed: bundleFollowed,
        bundle_size_bytes: bundleSizeBytes,
        contained_atjs_markers: bundleHadAtjsMarkers,
      },
    },
    migration_plan: {
      auto_mappable: mappings,
      manual_review: manualReview,
      blockers,
    },
    recommended_setup: {
      targetClientCode: clientCode,
      flickerSelectors,
      flickerStyle,
      consentMode,
      decisionScopes_default: Array.from(allMboxes).sort(),
      includeA4t: a4t.detected,
      notes,
    },
    warnings,
    summary,
  };
}

function emptyReport(url: string, warnings: string[]): AtjsAnalysisReport {
  return {
    url,
    http_status: 0,
    atjs: {
      present: false,
      version: "unknown",
      version_evidence: "no at.js markers",
      cdn_host: null,
      client_code: null,
      library_url: null,
      target_global_settings: {
        detected: false,
        source: "not-found",
        values: {},
        unmapped_keys: [],
      },
      mboxes: {
        declarative_dom: [],
        inline_calls: [],
        user_provided: [],
        total_unique: 0,
      },
      prehiding: {
        detected: false,
        style: "none",
        raw_css: null,
        hidden_selectors: [],
      },
      a4t: {
        detected: false,
        tracking_server: null,
        note: "no at.js context — A4T not assessed",
      },
      tags_bundle: {
        detected: false,
        url: null,
        followed: false,
        bundle_size_bytes: null,
        contained_atjs_markers: false,
      },
    },
    migration_plan: { auto_mappable: [], manual_review: [], blockers: [] },
    recommended_setup: {
      targetClientCode: null,
      flickerSelectors: null,
      flickerStyle: null,
      consentMode: "in",
      decisionScopes_default: [],
      includeA4t: false,
      notes: [],
    },
    warnings,
    summary: "no at.js implementation detected",
  };
}
