/**
 * Typed domain failures.
 *
 * Every failure a caller can reasonably handle is a tagged error class so the
 * Effect error channel stays narrow and adapters can branch on `_tag` or on the
 * rejection `code` without parsing message text.
 */
import { Schema } from "effect";
import { GOAL_ERROR_CODES, GOAL_STATUSES, type GoalErrorCode, type GoalStatus } from "./goal.ts";

/** A transition the state machine refuses. */
export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()(
    "InvalidTransitionError",
    {
        message: Schema.String,
        from: Schema.NullOr(Schema.Literals(GOAL_STATUSES)),
        to: Schema.Literals(GOAL_STATUSES),
    },
) {}

/** No goal exists for the requested operation. */
export class GoalNotFoundError extends Schema.TaggedErrorClass<GoalNotFoundError>()(
    "GoalNotFoundError",
    {
        message: Schema.String,
    },
) {}

/** The operation conflicts with existing goal state (unfinished goal, stale id). */
export class GoalConflictError extends Schema.TaggedErrorClass<GoalConflictError>()(
    "GoalConflictError",
    {
        message: Schema.String,
    },
) {}

/** Input validation failure (objective or budget). */
export class GoalValidationError extends Schema.TaggedErrorClass<GoalValidationError>()(
    "GoalValidationError",
    {
        message: Schema.String,
        field: Schema.Literals(["objective", "budget"]),
    },
) {}

/** A rule rejected the request; `code` tells the adapter what happened. */
export class GoalRejectedError extends Schema.TaggedErrorClass<GoalRejectedError>()(
    "GoalRejectedError",
    {
        message: Schema.String,
        code: Schema.Literals(GOAL_ERROR_CODES),
    },
) {}

/** The session entry could not be written. */
export class GoalPersistenceError extends Schema.TaggedErrorClass<GoalPersistenceError>()(
    "GoalPersistenceError",
    {
        message: Schema.String,
        detail: Schema.optional(Schema.String),
    },
) {}

/** Every failure the engine can return. */
export type GoalError =
    | InvalidTransitionError
    | GoalNotFoundError
    | GoalConflictError
    | GoalValidationError
    | GoalRejectedError
    | GoalPersistenceError;
