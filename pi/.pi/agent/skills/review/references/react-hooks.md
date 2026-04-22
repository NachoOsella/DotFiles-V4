# React Hooks Review Checklist

Use this reference when reviewing React (class or function component) code that uses Hooks.

## Rules of Hooks
- [ ] Hooks are called only at the top level of the function, not inside loops, conditions, or nested functions.
- [ ] Hooks are called only from React function components or custom Hooks, not from regular JavaScript functions or class component methods.

## useEffect
- [ ] Dependency array is complete. Missing dependencies cause stale closures or missed updates.
- [ ] Effect does not perform unconditional state updates that trigger infinite re-render loops.
- [ ] Cleanup function is provided when subscribing to external stores, event listeners, timers, or WebSockets.
- [ ] Async functions are not passed directly to `useEffect`; create an inner async function instead.

## useMemo / useCallback
- [ ] Used to avoid expensive recalculation or reference instability, not applied indiscriminately to every value.
- [ ] Dependency arrays are accurate; stale memoized values can hide bugs.

## Custom Hooks
- [ ] Named with the `use` prefix.
- [ ] Encapsulate related stateful logic rather than unrelated utilities.
- [ ] Return values and cleanup are documented and stable across renders where possible.

## Context
- [ ] Context providers are not placed too high, causing unnecessary re-renders for consumers.
- [ ] Context value object is memoized if it contains non-primitive values.

## Refs
- [ ] `useRef` is not misused as a state replacement when re-render is needed.
- [ ] DOM refs are checked for existence before use.
