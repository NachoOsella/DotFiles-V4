import { release } from "node:os";

export const DEFAULT_CODEX_VERSION = "0.143.0";
export const DEFAULT_CODEX_ORIGINATOR = "codex_cli_rs";

function mapPlatform(platform: string): string {
  switch (platform) {
    case "darwin":
      return "Mac OS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "freebsd":
      return "FreeBSD";
    default:
      return platform;
  }
}

function mapArch(arch: string): string {
  switch (arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "arm64";
    case "arm":
      return "arm";
    default:
      return arch;
  }
}

function terminalUserAgent(): string {
  const program = process.env.TERM_PROGRAM;
  if (program) {
    const version = process.env.TERM_PROGRAM_VERSION;
    const suffix = version ? ` ${version}` : "";
    return `${program}${suffix}`.trim();
  }
  if (process.env.WT_SESSION) {
    return "WindowsTerminal";
  }
  if (process.env.KITTY_WINDOW_ID) {
    return "kitty";
  }
  if (process.env.TMUX) {
    return "tmux";
  }
  const term = process.env.TERM;
  if (term && term !== "dumb") {
    return term;
  }
  return "unknown";
}

export function buildCodexUserAgent(version = DEFAULT_CODEX_VERSION): string {
  const osType = mapPlatform(process.platform);
  const osVersion = release();
  const arch = mapArch(process.arch);
  const terminal = terminalUserAgent();
  return `${DEFAULT_CODEX_ORIGINATOR}/${version} (${osType} ${osVersion}; ${arch}) ${terminal}`;
}

export function getCodexOriginator(): string {
  return DEFAULT_CODEX_ORIGINATOR;
}
