/**
 * stderr-only logger for the MCP server.
 *
 * MCP servers communicate with the host over stdio (stdout = JSON-RPC frames),
 * so any debug output MUST go to stderr to avoid corrupting the protocol.
 * Stderr is visible:
 *   • In PowerShell when running the server directly: `node build/index.js`
 *   • In MCP Inspector terminal output: `npm run inspect`
 *   • In Claude Desktop's mcp.log files at %APPDATA%/Claude/logs/
 *
 * Logs are gated by the DEBUG env var (any truthy value enables
 * verbose output). The minimum level is always "warn" so genuine problems
 * still surface even without the flag set.
 */

const isDebugOn = (): boolean => {
  const v = process.env.DEBUG;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
};

function format(prefix: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const line = `[${ts}] [debug:${prefix}] ${msg}`;
  if (data === undefined) return line + "\n";
  let dataStr: string;
  try {
    dataStr =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
  } catch {
    dataStr = "[unserializable]";
  }
  // Indent the data block so it's visually grouped under the message line.
  const indented = dataStr.split("\n").map((l) => `    ${l}`).join("\n");
  return line + "\n" + indented + "\n";
}

export const log = {
  /** Always emitted. Use sparingly — for important migration events. */
  info(msg: string, data?: unknown): void {
    process.stderr.write(format("info", msg, data));
  },
  /** Always emitted. */
  warn(msg: string, data?: unknown): void {
    process.stderr.write(format("warn", msg, data));
  },
  /** Always emitted. */
  error(msg: string, data?: unknown): void {
    process.stderr.write(format("error", msg, data));
  },
  /** Only emitted when DEBUG is set. Verbose internals. */
  debug(msg: string, data?: unknown): void {
    if (!isDebugOn()) return;
    process.stderr.write(format("debug", msg, data));
  },
  /** True iff DEBUG is set — for guarding expensive serializations. */
  isDebug: isDebugOn,
};
