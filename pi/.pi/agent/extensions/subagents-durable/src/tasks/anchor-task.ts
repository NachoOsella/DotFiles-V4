import { defineTask } from '@earendil-works/pi-durable'

// The terminal background owner remains traversable by full background abort.
export const AnchorTask = defineTask<null, { phase: 'done' }, null>({
    name: 'subagents.anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: {
        done: (_task, runtime, context) =>
            runtime.commit(
                () => ({
                    status: 'terminal',
                    outcome: { status: 'completed', result: null },
                }),
                context
            ),
    },
    abort: (_task, runtime, context) =>
        runtime.commit(
            () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
            context
        ),
})
