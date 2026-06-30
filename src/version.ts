/**
 * Single source of truth for the MCP version string.
 *
 * Reads `package.json` at module load (via fs, NOT a JSON import — the
 * project's tsconfig has `rootDir: "./src"` which blocks importing files
 * outside `src/`).
 *
 * Previously the version was duplicated in three places (package.json +
 * src/index.ts + src/index-http.ts), so a release bump required three
 * edits to stay in sync. This module collapses that to one.
 *
 * Path resolution: this file compiles to `build/version.js`. From there,
 * `../package.json` is the project root's package.json. The same relative
 * path also works when `tsx` runs `src/version.ts` directly (`../package.json`
 * from `src/` is still the project root).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const thisDir = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(thisDir, "..", "package.json");

interface MinimalPkg {
  version: string;
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as MinimalPkg;

export const VERSION = pkg.version;
