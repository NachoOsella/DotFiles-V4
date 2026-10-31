/**
 * Domain events.
 *
 * The engine reports what happened; adapters decide how to surface it (status
 * line, widget, transcript notice, notification). Events never carry prompts.
 */
import type { GoalStatus } from "./goal.ts";

export type GoalEvent =
    | {
          readonly type: "goal.created";
          readonly goalId: string;
          readonly objective: string;
          readonly at: number;
      }
    | {
          readonly type: "goal.status-changed";
          readonly goalId: string;
          readonly from: GoalStatus | null;
          readonly to: GoalStatus;
          readonly reason: string;
          readonly at: number;
      }
    | {
          readonly type: "goal.continued";
          readonly goalId: string;
          readonly turn: number;
          readonly at: number;
      }
    | {
          readonly type: "goal.wrapup";
          readonly goalId: string;
          readonly at: number;
      }
    | {
          readonly type: "goal.cleared";
          readonly goalId: string;
          readonly at: number;
      }
    | {
          readonly type: "goal.diagnostic";
          readonly message: string;
          readonly at: number;
      };
