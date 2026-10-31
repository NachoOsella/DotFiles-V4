import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
    asCustomMessage,
    commandNamed,
    commitSentMessage,
    createRecordingUI,
    isRecord,
    lastSnapshot,
    makeFakeContext,
    makeFakeHost,
    resultText,
    snapshots,
    toolNamed,
} from "./fake-host.ts";
import { FakeSession } from "./fake-session.ts";

test("dispatches handlers in registration order and collects return values", async () => {
    const host = makeFakeHost();
    const session = new FakeSession();
    host.setContext(makeFakeContext(session));

    const seen: string[] = [];
    const unsubscribe = host.api.on("agent_before_settle", (event) => {
        seen.push(event.outcome);
        return { continue: true };
    });
    host.api.on("agent_before_settle", () => ({ continue: false }));
    host.api.on("agent_start", () => undefined);

    const results = await host.emit({
        type: "agent_before_settle",
        outcome: "completed",
        entries: [],
    });
    assert.deepEqual(seen, ["completed"]);
    assert.deepEqual(results, [{ continue: true }, { continue: false }]);

    unsubscribe();
    assert.deepEqual(
        await host.emit({ type: "agent_before_settle", outcome: "completed", entries: [] }),
        [{ continue: false }],
    );
});

test("captures registered tools and commands", async () => {
    const host = makeFakeHost();
    const session = new FakeSession();
    const ctx = makeFakeContext(session);
    host.setContext(ctx);

    host.api.registerTool({
        name: "demo",
        label: "Demo",
        description: "demo tool",
        parameters: Type.Object({ value: Type.Optional(Type.String()) }),
        outputSchema: Type.Object({ value: Type.String() }),
        execute: async (_toolCallId, params) => ({
            content: [{ type: "text", text: `value=${String(params.value)}` }],
            details: null,
            structuredContent: { value: String(params.value) },
        }),
    });
    host.api.registerCommand("demo-command", {
        description: "demo command",
        handler: async () => {},
    });

    assert.deepEqual([...host.tools.keys()], ["demo"]);
    assert.deepEqual([...host.commands.keys()], ["demo-command"]);
    assert.equal(commandNamed(host, "demo-command").description, "demo command");

    const tool = toolNamed(host, "demo");
    assert.notEqual(tool.outputSchema, undefined);
    const result = await tool.execute("call-1", { value: "x" }, undefined, undefined, ctx);
    assert.equal(resultText(result), "value=x");
    assert.deepEqual(result.structuredContent, { value: "x" });
});

test("appendEntry writes to the fake session and records the payload", () => {
    const host = makeFakeHost();
    const session = new FakeSession();
    host.setContext(makeFakeContext(session));

    host.api.appendEntry("goal-snapshot", { status: "active" });

    const branch = session.getBranch();
    assert.equal(branch.length, 1);
    assert.equal(branch[0]?.customType, "goal-snapshot");
    assert.deepEqual(host.appended, [
        { customType: "goal-snapshot", data: { status: "active" } },
    ]);
    assert.deepEqual(lastSnapshot(host), { status: "active" });
    assert.equal(snapshots(host).length, 1);
});

test("sendMessage records the message and the options", () => {
    const host = makeFakeHost();
    const session = new FakeSession();
    host.setContext(makeFakeContext(session));

    host.api.sendMessage(
        { customType: "goal-directive", content: "go", display: false, details: { kind: "kickoff" } },
        { triggerTurn: true },
    );

    assert.equal(host.sentMessages.length, 1);
    const message = asCustomMessage(host.sentMessages[0]?.message);
    assert.equal(message.customType, "goal-directive");
    assert.equal(message.display, false);
    assert.ok(isRecord(message.details));
    assert.equal(message.details.kind, "kickoff");
    assert.ok(isRecord(host.sentMessages[0]?.options));
    assert.equal(host.sentMessages[0]?.options.triggerTurn, true);

    const committed = commitSentMessage(session, host);
    assert.equal(committed.customType, "goal-directive");
    assert.equal(committed.display, false);
});

test("confirm and editor answers follow the configured values", async () => {
    const host = makeFakeHost();
    const session = new FakeSession();
    const ctx = makeFakeContext(session, { confirm: false });
    host.setContext(ctx);

    assert.equal(await ctx.ui.confirm("title", "message"), false);
    host.setConfirmAnswer(true);
    assert.equal(await ctx.ui.confirm("title", "message"), true);

    assert.equal(await ctx.ui.editor("title", "prefill"), undefined);
    ctx.setEditorAnswer("accepted");
    assert.equal(await ctx.ui.editor("title", "prefill"), "accepted");
});

test("isIdle follows the context and host knobs", () => {
    const host = makeFakeHost();
    const ctx = makeFakeContext(new FakeSession());
    host.setContext(ctx);

    assert.equal(ctx.isIdle(), true);
    host.setIdle(false);
    assert.equal(ctx.isIdle(), false);
    ctx.setIdle(true);
    assert.equal(ctx.isIdle(), true);
});

test("UI records notifications, statuses, and widgets", async () => {
    const host = makeFakeHost();
    const ctx = makeFakeContext(new FakeSession());
    host.setContext(ctx);

    ctx.ui.notify("hello", "warning");
    ctx.ui.setStatus("goal", "active");
    ctx.ui.setWidget("goal", ["line"], { placement: "aboveEditor" });

    assert.deepEqual(ctx.ui.notifications, [{ message: "hello", type: "warning" }]);
    assert.deepEqual(ctx.ui.statuses, [{ key: "goal", text: "active" }]);
    assert.deepEqual(ctx.ui.widgets, [
        { key: "goal", content: ["line"], placement: "aboveEditor" },
    ]);
    assert.equal(host.ui, ctx.ui);

    const unsubscribe = ctx.ui.onTerminalInput(() => undefined);
    assert.equal(typeof unsubscribe, "function");
    unsubscribe();

    const standalone = createRecordingUI();
    assert.deepEqual(standalone.notifications, []);
});
