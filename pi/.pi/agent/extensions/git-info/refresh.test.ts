import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import gitInfo from "./index.ts";
import {
  GIT_INFO_CHANNEL,
  type GitInfoState,
} from "../shared/dashboard-state.ts";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();
assert.ok(REAL_GIT, "git must be available to run these tests");

const GIT_SHIM = `#!/bin/sh
mode="\${GIT_SHIM_MODE:-ok}"
case "$mode" in
  slow-status)
    case " $* " in
      *" status "*) sleep 5;;
    esac
    exec "$REAL_GIT" "$@";;
  slow-all)
    sleep 0.4
    exec "$REAL_GIT" "$@";;
  fail-status)
    case " $* " in
      *" status "*) echo "fatal: unable to read status" >&2; exit 1;;
    esac
    exec "$REAL_GIT" "$@";;
  huge-status)
    case " $* " in
      *" status "*) yes " M filler.txt" | head -n 30000; exit 0;;
    esac
    exec "$REAL_GIT" "$@";;
  fatal-repo)
    case " $* " in
      *"is-inside-work-tree"*)
        echo "fatal: not a git repository (or any of the parent directories): .git" >&2
        exit 128;;
    esac
    exec "$REAL_GIT" "$@";;
  *)
    exec "$REAL_GIT" "$@";;
esac
`;

const GH_SHIM = `#!/bin/sh\nexit 1\n`;

interface FakePi {
  api: ExtensionAPI;
  handlers: Map<string, unknown>;
  commands: Map<string, unknown>;
  emitted: Array<{ channel: string; payload: unknown }>;
}

function setupFake(): FakePi {
  const fake: FakePi = {
    api: undefined as unknown as ExtensionAPI,
    commands: new Map(),
    emitted: [],
    handlers: new Map(),
  };
  fake.api = {
    events: {
      emit: (channel: string, payload: unknown) => {
        fake.emitted.push({ channel, payload });
      },
      on: () => {},
    },
    on: (event: string, handler: unknown) => {
      fake.handlers.set(event, handler);
    },
    registerCommand: (name: string, options: unknown) => {
      fake.commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  return fake;
}

function makeCtx(cwd: string, notified: string[]): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    signal: undefined,
    ui: {
      notify: (message: string) => {
        notified.push(message);
      },
    },
  } as unknown as ExtensionContext;
}

function gitStates(fake: FakePi): GitInfoState[] {
  return fake.emitted
    .filter((entry) => entry.channel === GIT_INFO_CHANNEL)
    .map((entry) => entry.payload as GitInfoState);
}

function makeRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "git-info-refresh-test-"));
  execFileSync(REAL_GIT, ["init", "-q", dir]);
  execFileSync(REAL_GIT, ["-C", dir, "checkout", "-qb", branch]);
  writeFileSync(join(dir, "notes.txt"), "hello\n");
  return dir;
}

const getHandler = <T>(fake: FakePi, event: string): T => {
  const handler = fake.handlers.get(event);
  assert.ok(handler, `expected a handler for ${event}`);
  return handler as T;
};

type SessionStart = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

let binDir: string;
let originalPath: string | undefined;

test.before(() => {
  binDir = mkdtempSync(join(tmpdir(), "git-info-shim-bin-"));
  writeFileSync(join(binDir, "git"), GIT_SHIM, { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);
  writeFileSync(join(binDir, "gh"), GH_SHIM, { mode: 0o755 });
  chmodSync(join(binDir, "gh"), 0o755);
  mkdirSync(binDir, { recursive: true });
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.REAL_GIT = REAL_GIT;
});

test.after(() => {
  process.env.PATH = originalPath;
  delete process.env.REAL_GIT;
  delete process.env.GIT_SHIM_MODE;
});

test.afterEach(() => {
  delete process.env.GIT_SHIM_MODE;
});

async function shutdown(fake: FakePi) {
  const handler = fake.handlers.get("session_shutdown") as
    (() => Promise<void>) | undefined;
  if (handler) await handler();
}

test("publishes repository data for a dirty checkout", async () => {
  const fake = setupFake();
  gitInfo(fake.api);
  try {
    const repo = makeRepo("alpha");
    await getHandler<SessionStart>(fake, "session_start")(
      {},
      makeCtx(repo, []),
    );

    const states = gitStates(fake);
    assert.ok(states.length >= 1);
    const last = states.at(-1)!;
    assert.equal(last.isRepository, true);
    assert.equal(last.branch, "alpha");
    assert.equal(last.changedFiles, 1);
  } finally {
    await shutdown(fake);
  }
});

test("preserves prior data when git status times out", async () => {
  const fake = setupFake();
  gitInfo(fake.api);
  try {
    const notified: string[] = [];
    const repo = makeRepo("alpha");
    await getHandler<SessionStart>(fake, "session_start")(
      {},
      makeCtx(repo, notified),
    );
    assert.equal(gitStates(fake).at(-1)?.changedFiles, 1);

    process.env.GIT_SHIM_MODE = "slow-status";
    const pr = fake.commands.get("pr") as { handler: CommandHandler };
    await pr.handler("", makeCtx(repo, notified));

    const states = gitStates(fake);
    assert.ok(states.length >= 1);
    for (const state of states) {
      assert.equal(state.isRepository, true);
    }
    const last = states.at(-1)!;
    assert.equal(last.branch, "alpha");
    assert.equal(last.changedFiles, 1);
    assert.match(notified.join("\n"), /No open PR found for alpha/);
  } finally {
    await shutdown(fake);
  }
});

test("never counts truncated status output as complete", async () => {
  const fake = setupFake();
  gitInfo(fake.api);
  try {
    const notified: string[] = [];
    const repo = makeRepo("alpha");
    await getHandler<SessionStart>(fake, "session_start")(
      {},
      makeCtx(repo, notified),
    );
    assert.equal(gitStates(fake).at(-1)?.changedFiles, 1);

    process.env.GIT_SHIM_MODE = "huge-status";
    const pr = fake.commands.get("pr") as { handler: CommandHandler };
    await pr.handler("", makeCtx(repo, notified));

    const states = gitStates(fake);
    const last = states.at(-1)!;
    assert.equal(last.isRepository, true);
    assert.equal(last.changedFiles, 1);
    for (const state of states) {
      assert.ok(
        state.changedFiles < 1000,
        "truncated status output should never be counted",
      );
    }
  } finally {
    await shutdown(fake);
  }
});

test("clears state for a definitive non-repository error", async () => {
  const fake = setupFake();
  gitInfo(fake.api);
  try {
    const repo = makeRepo("alpha");
    await getHandler<SessionStart>(fake, "session_start")(
      {},
      makeCtx(repo, []),
    );
    assert.equal(gitStates(fake).at(-1)?.isRepository, true);

    process.env.GIT_SHIM_MODE = "fatal-repo";
    const pr = fake.commands.get("pr") as { handler: CommandHandler };
    await pr.handler("", makeCtx(repo, []));

    const last = gitStates(fake).at(-1)!;
    assert.equal(last.isRepository, false);
    assert.equal(last.branch, null);
  } finally {
    await shutdown(fake);
  }
});

test("a stale slow refresh never overwrites newer data", async () => {
  const fake = setupFake();
  gitInfo(fake.api);
  try {
    const repoA = makeRepo("alpha");
    const repoB = makeRepo("beta");
    process.env.GIT_SHIM_MODE = "slow-all";

    const sessionStart = getHandler<SessionStart>(fake, "session_start");
    const first = sessionStart({}, makeCtx(repoA, []));
    const second = sessionStart({}, makeCtx(repoB, []));
    await Promise.all([first, second]);

    const states = gitStates(fake);
    assert.ok(states.length >= 1);
    for (const state of states) {
      assert.equal(state.branch, "beta");
    }
    const last = states.at(-1)!;
    assert.equal(last.isRepository, true);
    assert.equal(last.changedFiles, 1);
  } finally {
    await shutdown(fake);
  }
});
