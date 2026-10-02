/**
 * Discoverable coding-agent entry point.
 *
 * The current coding-agent CLI has no stable Durable host seam: its root
 * conversation is owned by the legacy `AgentSession`/`SessionManager` runtime
 * and it exposes no Harness, request IDs, or transactional delivery. This
 * extension therefore stays inert. It registers no tools, commands, watchers,
 * or lifecycle handlers, and the existing `subagents` extension remains the
 * production implementation.
 *
 * Native Durable hosts import `createSubagentsExtension` from
 * `./src/extension.js` and install it in their Registry before opening storage
 * and calling `resume()`.
 */
export default function subagentsDurableExtension(): void {
    // Intentionally inert until a stable Durable-native host interface exists.
}
