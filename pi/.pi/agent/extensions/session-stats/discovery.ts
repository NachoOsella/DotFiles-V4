import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SESSION_PREVIEW_BYTES = 64 * 1024;

export interface SessionFileMetadata {
  readonly path: string;
  readonly cwd?: string;
  readonly name?: string;
  readonly parentSessionPath?: string;
  readonly created?: Date;
}

/** Discover session files without parsing every complete transcript. */
export async function discoverSessionFiles(
  sessionsDir = join(getAgentDir(), "sessions"),
): Promise<SessionFileMetadata[]> {
  const directories = await safeReadDirectories(sessionsDir);
  const nestedFiles = await Promise.all(
    directories.map(async (directory) => {
      const directoryPath = join(sessionsDir, directory);
      const entries = await safeReadFiles(directoryPath);
      return entries
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => join(directoryPath, entry));
    }),
  );
  return Promise.all(nestedFiles.flat().map(readSessionMetadata));
}

async function readSessionMetadata(path: string): Promise<SessionFileMetadata> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(SESSION_PREVIEW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const preview = buffer.toString("utf8", 0, bytesRead);
    const lines = preview.split(/\r?\n/);
    const header = parseRecord(lines[0]);
    let name: string | undefined;
    for (const line of lines.slice(1)) {
      const entry = parseRecord(line);
      if (entry?.type === "session_info") {
        name = typeof entry.name === "string" ? entry.name.trim() : undefined;
      }
    }
    const timestamp =
      typeof header?.timestamp === "string" ? header.timestamp : "";
    const createdTime = Date.parse(timestamp);
    return {
      path,
      cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
      name: name || undefined,
      parentSessionPath:
        typeof header?.parentSession === "string"
          ? header.parentSession
          : undefined,
      created: Number.isNaN(createdTime) ? undefined : new Date(createdTime),
    };
  } catch {
    return { path };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function safeReadDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function safeReadFiles(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function parseRecord(
  line: string | undefined,
): Record<string, unknown> | undefined {
  if (!line) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
