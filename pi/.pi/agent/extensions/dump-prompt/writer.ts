import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatPayloadAsMd } from "./formatter.js";
import type { PromptPayload } from "./types.js";

/** Default output paths for prompt dump artifacts. */
export function getDumpPaths(): { jsonPath: string; mdPath: string } {
  return {
    jsonPath: join(homedir(), "pi-prompt-dump.json"),
    mdPath: join(homedir(), "pi-prompt-dump.md"),
  };
}

/** Write the captured provider payload to JSON and Markdown files. */
export function writeDump(payload: PromptPayload): void {
  const { jsonPath, mdPath } = getDumpPaths();
  const json = JSON.stringify(payload, null, 2);
  const md = formatPayloadAsMd(payload);

  writeFileSync(jsonPath, json, "utf-8");
  writeFileSync(mdPath, md, "utf-8");
}
