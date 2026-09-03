/** File writing with safe path handling. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function writeReportToFile(
  content: string,
  targetPath: string,
  cwd: string,
): string {
  const resolved = resolve(cwd, targetPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, "utf-8");
  return resolved;
}

export function defaultDumpPath(cwd: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(cwd, `pi-prompt-dump-${ts}.md`);
}
