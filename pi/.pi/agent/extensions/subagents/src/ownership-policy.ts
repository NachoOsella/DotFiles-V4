/**
 * Parent-owned child restrictions: child runtimes are inspectable and
 * interruptible through collaboration tools, but never directly
 * steerable through ordinary user/extension paths.
 */

export type ChildOperation =
    | 'inspect'
    | 'interrupt'
    | 'collaboration-message'
    | 'direct-steer'
    | 'settings-mutation'

export function isChildOperationAllowed(operation: ChildOperation): boolean {
    switch (operation) {
        case 'inspect':
        case 'interrupt':
        case 'collaboration-message':
            return true
        case 'direct-steer':
        case 'settings-mutation':
            return false
    }
}
