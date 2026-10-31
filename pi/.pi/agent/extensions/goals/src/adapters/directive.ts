/**
 * Goal directives: the model-visible messages that start and continue a goal.
 *
 * A directive is a `custom_message` entry. Pi converts it to a user message for
 * the provider, and returning it as a boundary draft is what makes an
 * `agent_before_settle` continuation valid.
 */
import type {
    CustomMessageEntryDraft,
    SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import type { GoalHostApi } from "./host.ts";
import {
    GOAL_DIRECTIVE_CUSTOM_TYPE,
    type DirectiveKind,
    type GoalDirectiveDetails,
    type GoalView,
} from "../domain/goal.ts";

/** Details attached to every directive, used to derive turns and dedupe boundaries. */
export function directiveDetails(
    view: GoalView,
    kind: DirectiveKind,
    anchorEntryId: string | null,
): GoalDirectiveDetails {
    return {
        goalId: view.snapshot.goalId,
        kind,
        turn: kind === "kickoff" ? 1 : view.metrics.goalTurns + 1,
        anchorEntryId,
    };
}

/** Build the boundary draft for a continuation or wrap-up turn. */
export function buildDirectiveDraft(
    view: GoalView,
    prompt: string,
    kind: DirectiveKind,
    anchorEntryId: string | null,
    display: boolean,
): CustomMessageEntryDraft {
    return {
        type: "custom_message",
        customType: GOAL_DIRECTIVE_CUSTOM_TYPE,
        content: prompt,
        display,
        details: directiveDetails(view, kind, anchorEntryId),
    };
}

/** Start a run from a directive (used by `/goal <objective>`, `resume`, `edit`). */
export function sendDirective(
    pi: Pick<GoalHostApi, "sendMessage">,
    view: GoalView,
    prompt: string,
    kind: DirectiveKind,
    display: boolean,
): void {
    pi.sendMessage(
        {
            customType: GOAL_DIRECTIVE_CUSTOM_TYPE,
            content: prompt,
            display,
            details: directiveDetails(view, kind, null),
        },
        { triggerTurn: true },
    );
}
