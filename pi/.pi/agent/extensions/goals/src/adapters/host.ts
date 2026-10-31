/**
 * Narrow view of `ExtensionAPI` used by the adapters.
 *
 * Keeping the adapters on a structural subset means tests can drive them with a
 * small fake host instead of implementing the full Pi extension surface, while
 * `ExtensionAPI` remains assignable at the real entry point.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GoalHostApi = Pick<
    ExtensionAPI,
    "on" | "registerTool" | "registerCommand" | "appendEntry" | "sendMessage"
>;
