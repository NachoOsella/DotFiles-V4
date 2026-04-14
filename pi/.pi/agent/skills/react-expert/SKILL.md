---
name: react-expert
description: "Implementation and review of high-quality React components and hooks. Use when you need to: (1) build or refactor React components, (2) create custom hooks, (3) optimize component performance, (4) implement state management, (5) ensure accessibility in React apps, or (6) write React tests."
---

# React Development

## Functional Components

```tsx
interface UserCardProps {
  user: User;
  onSelect: (id: string) => void;
}

export function UserCard({ user, onSelect }: UserCardProps) {
  const handleClick = useCallback(() => {
    onSelect(user.id);
  }, [user.id, onSelect]);

  return (
    <article onClick={handleClick}>
      <h2>{user.name}</h2>
      <p>{user.email}</p>
    </article>
  );
}
```

## Custom Hooks

```tsx
function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : initialValue;
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}
```

## Performance Optimization

- `useMemo` for expensive calculations
- `useCallback` for stable function references
- `React.memo` for pure components
- Virtualization for long lists (react-window, tanstack-virtual)

## State Management

| Scope | Solution |
|-------|----------|
| Local state | `useState`, `useReducer` |
| Shared state | Context API, Zustand, Jotai |
| Server state | TanStack Query, SWR |
| Global complex | Redux Toolkit |

## Guidelines

- Follow project's established conventions
- Prioritize readability and simplicity
- Ensure components are testable and accessible
- Prefer composition over prop drilling
