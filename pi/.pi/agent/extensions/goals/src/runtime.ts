/**
 * Runtime glue shared by the Pi adapters.
 *
 * Owns the Effect runtime for the engine, the transient run timing, and the
 * timestamp of the last interrupt so a manual `/compact` can be explained.
 */
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_MAX_GOAL_TURNS,
    DEFAULT_MAX_IDLE_TURNS,
    type GoalContextInput,
    type GoalView,
} from "./domain/goal.ts";
import type { GoalError } from "./domain/errors.ts";
import { GoalEngine, makeGoalEngineLayer, type GoalEngineShape } from "./services/goal-controller.ts";

/** Configuration resolved once per extension load. */
export interface GoalsConfig {
    readonly maxGoalTurns: number;
    readonly maxIdleTurns: number;
    readonly showDirectives: boolean;
    /** Budget applied when `/goal <objective>` does not specify one; null is unlimited. */
    readonly defaultBudgetTokens: number | null;
    /** Hard ceiling for any goal budget, from the command or the tool. */
    readonly maxBudgetTokens: number;
    /** Allow `create_goal` without UI in non-interactive modes. Off by default. */
    readonly allowUnattendedCreate: boolean;
}

const DEFAULT_MAX_BUDGET_TOKENS = 2_000_000;

function readPositiveInt(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.floor(parsed);
    return rounded > 0 ? rounded : fallback;
}

/** Read an optional positive integer; 0, empty, and invalid values mean "unset". */
function readOptionalPositiveInt(value: string | undefined): number | null {
    if (value === undefined || value.trim() === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const rounded = Math.floor(parsed);
    return rounded > 0 ? rounded : null;
}

/** Read tunables from the environment. Invalid values fall back to defaults. */
export function loadGoalsConfig(env: Record<string, string | undefined> = process.env): GoalsConfig {
    return {
        maxGoalTurns: readPositiveInt(env.PI_GOAL_MAX_TURNS, DEFAULT_MAX_GOAL_TURNS),
        maxIdleTurns: readPositiveInt(env.PI_GOAL_MAX_IDLE_TURNS, DEFAULT_MAX_IDLE_TURNS),
        showDirectives: env.PI_GOAL_SHOW_DIRECTIVES === "1",
        defaultBudgetTokens: readOptionalPositiveInt(env.PI_GOAL_DEFAULT_BUDGET),
        maxBudgetTokens: readPositiveInt(
            env.PI_GOAL_MAX_BUDGET,
            DEFAULT_MAX_BUDGET_TOKENS,
        ),
        allowUnattendedCreate: env.PI_GOAL_ALLOW_UNATTENDED_CREATE === "1",
    };
}

/** Outcome of running one engine effect. */
export type EngineRun<A> =
    | { readonly ok: true; readonly value: A }
    | { readonly ok: false; readonly message: string };

/**
 * One safe line for user- and model-facing errors. Typed failures carry their
 * message; defects are reduced to the first line of the squashed error so no
 * stack trace, absolute path, or Effect internal reaches a tool result.
 */
function describeExit(exit: Exit.Exit<unknown, unknown>): string {
    const failure = Exit.findErrorOption(exit);
    if (Option.isSome(failure)) {
        const message = messageOf(failure.value);
        return message.length > 2000 ? `${message.slice(0, 1997)}...` : message;
    }
    if (Exit.isFailure(exit)) {
        const [first] = Cause.prettyErrors(exit.cause);
        if (first !== undefined && first.message.length > 0) return clipLine(first.message);
        return clipLine(Cause.pretty(exit.cause));
    }
    return "unknown goal engine failure";
}

function messageOf(value: unknown): string {
    if (typeof value === "object" && value !== null) {
        const message: unknown = Reflect.get(value, "message");
        if (typeof message === "string" && message.length > 0) {
            const detail: unknown = Reflect.get(value, "detail");
            return typeof detail === "string" && detail.length > 0
                ? `${message}: ${detail}`
                : message;
        }
    }
    return String(value);
}

function clipLine(text: string): string {
    const firstLine = text.split("\n")[0]?.trim() ?? "";
    const bounded = firstLine.length > 0 ? firstLine : "goal engine failure";
    return bounded.length > 300 ? `${bounded.slice(0, 297)}...` : bounded;
}

export class GoalRuntime {
    readonly config: GoalsConfig;
    private readonly engineRuntime: ManagedRuntime.ManagedRuntime<GoalEngine, never>;
    private readonly pi: ExtensionAPI;
    private runStartedAt: number | null = null;
    private lastInterruptAt: number | null = null;

    constructor(pi: ExtensionAPI, config: GoalsConfig) {
        this.pi = pi;
        this.config = config;
        const engineLayer = makeGoalEngineLayer({
            maxGoalTurns: config.maxGoalTurns,
            maxIdleTurns: config.maxIdleTurns,
            maxBudgetTokens: config.maxBudgetTokens,
        });
        this.engineRuntime = ManagedRuntime.make(engineLayer);
    }

    /** Engine input bound to a Pi context. */
    context(ctx: ExtensionContext, now: number = Date.now()): GoalContextInput {
        return {
            readBranch: () => ctx.sessionManager.getBranch(),
            appendEntry: (customType, data) => this.pi.appendEntry(customType, data),
            sessionId: ctx.sessionManager.getSessionId(),
            now,
            elapsedMs: this.runStartedAt === null ? 0 : Math.max(0, now - this.runStartedAt),
        };
    }

    /** Run one engine effect, converting failures into a printable result. */
    async run<A>(
        build: (engine: GoalEngineShape) => Effect.Effect<A, GoalError, GoalEngine>,
    ): Promise<EngineRun<A>> {
        try {
            const exit = await this.engineRuntime.runPromiseExit(
                Effect.gen(function* () {
                    const engine = yield* GoalEngine;
                    return yield* build(engine);
                }),
            );
            if (Exit.isSuccess(exit)) {
                return { ok: true, value: exit.value };
            }
            return { ok: false, message: describeExit(exit) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, message };
        }
    }

    /** Current view (null when there is no goal) or the read failure. */
    async view(ctx: ExtensionContext): Promise<EngineRun<GoalView | null>> {
        const result = await this.run((engine) => engine.view(this.context(ctx)));
        if (!result.ok) return result;
        return { ok: true, value: result.value.view };
    }

    /**
     * Mark the start of an agent run. Pi emits `agent_start` again for every
     * continuation inside one `_startRun`, and only the final settlement ends
     * the span, so an already open span is never reset.
     */
    beginRun(now: number = Date.now()): void {
        if (this.runStartedAt === null) {
            this.runStartedAt = now;
        }
    }

    /** Returns the milliseconds the run was active, then clears the start time. */
    endRun(now: number = Date.now()): number {
        const started = this.runStartedAt;
        this.runStartedAt = null;
        if (started === null) return 0;
        return Math.max(0, now - started);
    }

    markInterrupt(now: number = Date.now()): void {
        this.lastInterruptAt = now;
    }

    /**
     * True when an interrupt happened recently enough to belong to this manual
     * compaction. Pi gives no causal link, so this is a narrow timing heuristic:
     * `compact()` aborts the run and emits `session_before_compact` milliseconds
     * later, while a human pressing Escape and then typing `/compact` is slower
     * than this window. It is not proof; a false positive only means the goal
     * stays active after an interrupt.
     */
    hasRecentInterrupt(now: number = Date.now(), windowMs = 1500): boolean {
        if (this.lastInterruptAt === null) return false;
        return now - this.lastInterruptAt <= windowMs;
    }

    clearInterrupt(): void {
        this.lastInterruptAt = null;
    }

    /** Stop accepting new work; in-flight effects finish against the live runtime. */
    detach(): void {
        this.runStartedAt = null;
        this.lastInterruptAt = null;
    }

    async dispose(): Promise<void> {
        this.runStartedAt = null;
        try {
            await this.engineRuntime.dispose();
        } catch {
            // Shutdown must stay idempotent; Pi is already tearing the runtime down.
        }
    }
}
