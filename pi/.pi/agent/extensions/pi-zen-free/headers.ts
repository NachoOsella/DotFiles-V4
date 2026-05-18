import { OPENCODE_CLI_USER_AGENT } from "./config.js";

/** Create an identifier compatible with the OpenCode CLI Zen headers. */
function createClientId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Build headers that make Zen requests use the same free bucket as OpenCode CLI.
 *
 * Zen applies very restrictive anonymous limits when these client headers are
 * missing, even with the public token. A stable session/project id is enough for
 * one Pi process, while each process gets fresh ids.
 */
export function createOpenCodeZenHeaders(): Record<string, string> {
  return {
    "User-Agent": OPENCODE_CLI_USER_AGENT,
    "x-opencode-client": "cli",
    "x-opencode-session": createClientId("ses"),
    "x-opencode-project": createClientId("proj"),
    "x-opencode-request": createClientId("req"),
  };
}
