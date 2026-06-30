#!/usr/bin/env node

/**
 * Target Web SDK Foundation MCP server
 *
 * One MCP server, one job: bootstrap a complete Adobe Target Web SDK
 * implementation. From zero credentials to a working dev embed code in
 * a single tool call.
 *
 * Tools (20):
 *   • Datastreams (4)    list / create / add Target / add Analytics
 *   • Property setup (8) list / create property / host+envs / install
 *                        Web SDK / data elements / rules / status / embed
 *   • Library (2)        create dev library + build / status
 *   • Validation (5)     datastream / property / live edge test /
 *                        website html / full report
 *   • Orchestration (1)  setup_target_websdk — the one-shot wizard
 *
 * Auth: Adobe OAuth Server-to-Server via IMS
 * Transport: stdio (Claude Desktop, Claude Code, Cursor, etc.)
 *
 * Maintained by Vikas-O7 · https://github.com/Vikas-O7/target-websdk-foundation
 * Independent open-source tool. Not affiliated with Adobe.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerDatastreamTools } from "./tools/datastream-tools.js";
import { registerSetupTools } from "./tools/setup-tools.js";
import { registerLibraryTools } from "./tools/library-tools.js";
import { registerValidationTools } from "./tools/validation-tools.js";
import { registerOrchestrationTools } from "./tools/orchestration-tools.js";
import { registerDiscoveryTools } from "./tools/discovery-tools.js";
import { registerArchetypeTools } from "./tools/archetype-tools.js";
import { registerCatalogSyncTools } from "./tools/catalog-sync-tools.js";
import { registerAtjsAnalysisTools } from "./tools/atjs-analysis-tools.js";
import { VERSION } from "./version.js";

const server = new McpServer({
  name: "target-websdk-foundation",
  version: VERSION,
});

registerDatastreamTools(server);
registerSetupTools(server);
registerLibraryTools(server);
registerValidationTools(server);
registerOrchestrationTools(server);
registerDiscoveryTools(server);
registerArchetypeTools(server);
registerCatalogSyncTools(server);
registerAtjsAnalysisTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("═══════════════════════════════════════════════════════");
console.error(`  Target Web SDK Foundation v${VERSION}`);
console.error("  28 tools registered across 9 tool groups");
console.error("  Transport: stdio");
console.error("  Maintained by Vikas-O7");
console.error("  https://github.com/Vikas-O7/target-websdk-foundation");
console.error("═══════════════════════════════════════════════════════");
