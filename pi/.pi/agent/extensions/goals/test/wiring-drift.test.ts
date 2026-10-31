import assert from "node:assert/strict";
import test from "node:test";
import { GOAL_SNAPSHOT_CUSTOM_TYPE } from "../src/domain/goal.ts";
import {
    asCustomMessage,
    commandNamed,
    isRecord,
    isUnknownArray,
    makeGoalHarness,
    toolNamed,
    type ToolDefinitionLike,
} from "./support/fake-host.ts";

/** Sorted so a rename or an added handler breaks the assertion loudly. */
function sortedNames(names: Iterable<string>): string[] {
    return [...names].sort();
}

function parametersOf(tool: ToolDefinitionLike): Record<string, unknown> {
    const parameters: unknown = tool.parameters;
    assert.ok(isRecord(parameters), `${tool.name} parameters must be an object schema`);
    return parameters;
}

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
    assert.ok(isRecord(schema.properties), "object schema must declare properties");
    return schema.properties;
}

test("the extension registers exactly the expected events, tools, and commands", async () => {
    const harness = makeGoalHarness();
    try {
        assert.deepEqual(sortedNames(harness.host.handlers.keys()), [
            "agent_before_settle",
            "agent_settled",
            "agent_start",
            "session_before_compact",
            "session_shutdown",
            "session_start",
            "session_tree",
        ]);
        assert.deepEqual(sortedNames(harness.host.tools.keys()), [
            "create_goal",
            "get_goal",
            "update_goal",
        ]);
        assert.deepEqual(sortedNames(harness.host.commands.keys()), ["goal"]);
    } finally {
        await harness.close();
    }
});

test("persistence uses the goal snapshot, directive, and cleared custom types", async () => {
    const harness = makeGoalHarness();
    try {
        const { host, session, ctx } = harness;
        session.appendUser("set a goal");
        session.appendAssistant({ text: "ok" });

        await commandNamed(host, "goal").handler("ship the release", ctx);

        assert.equal(GOAL_SNAPSHOT_CUSTOM_TYPE, "goal-snapshot");
        assert.equal(host.appended[0]?.customType, "goal-snapshot");
        const sent = host.sentMessages[0];
        assert.ok(sent !== undefined);
        const directive = asCustomMessage(sent.message);
        assert.equal(directive.customType, "goal-directive");

        await commandNamed(host, "goal").handler("clear", ctx);
        assert.equal(host.appended.at(-1)?.customType, "goal-cleared");
    } finally {
        await harness.close();
    }
});

test("update_goal accepts only complete, blocked, and paused", async () => {
    const harness = makeGoalHarness();
    try {
        const updateSchema = parametersOf(toolNamed(harness.host, "update_goal"));

        const status = propertiesOf(updateSchema).status;
        assert.ok(isRecord(status), "update_goal has a status property");
        assert.ok(isUnknownArray(status.anyOf), "status is a union schema");

        const statuses = status.anyOf.map((variant) => {
            assert.ok(isRecord(variant), "union variant is an object");
            assert.equal(variant.type, "string");
            return variant.const;
        });
        assert.deepEqual(statuses, ["complete", "blocked", "paused"]);

        assert.ok(isUnknownArray(updateSchema.required), "update_goal has required fields");
        assert.deepEqual(updateSchema.required, ["status"]);
    } finally {
        await harness.close();
    }
});

test("create_goal requires an objective", async () => {
    const harness = makeGoalHarness();
    try {
        const createSchema = parametersOf(toolNamed(harness.host, "create_goal"));

        assert.ok(isUnknownArray(createSchema.required), "create_goal has required fields");
        assert.deepEqual(createSchema.required, ["objective"]);

        const objective = propertiesOf(createSchema).objective;
        assert.ok(isRecord(objective), "create_goal has an objective property");
        assert.equal(objective.type, "string");
    } finally {
        await harness.close();
    }
});

test("get_goal takes no required parameters", async () => {
    const harness = makeGoalHarness();
    try {
        const getSchema = parametersOf(toolNamed(harness.host, "get_goal"));
        assert.deepEqual(Object.keys(propertiesOf(getSchema)), []);
        assert.equal(getSchema.required, undefined);
    } finally {
        await harness.close();
    }
});
