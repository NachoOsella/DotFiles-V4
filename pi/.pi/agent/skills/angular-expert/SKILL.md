---
name: angular-expert
description: "Deep expertise in Angular (v17+), including Signals, Hydration, and Standalone Components. Use when you need to: (1) build modern Angular applications, (2) implement Signals for state management, (3) optimize with SSR and Hydration, (4) create standalone components, (5) design reactive forms, or (6) write Angular tests with Jest/Playwright."
---

# Angular Development (v17+)

## Standalone Components

```typescript
@Component({
  selector: 'app-user',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (user()) {
      <h1>{{ user().name }}</h1>
    }
  `
})
export class UserComponent {
  user = input.required<User>();
}
```

## Signals

```typescript
@Component({...})
export class CounterComponent {
  count = signal(0);
  doubleCount = computed(() => this.count() * 2);
  
  increment() {
    this.count.update(c => c + 1);
  }
}
```

## Control Flow Syntax

```html
@if (isLoading()) {
  <app-spinner />
} @else {
  @for (item of items(); track item.id) {
    <app-item [data]="item" />
  } @empty {
    <p>No items found</p>
  }
}
```

## Dependency Injection

```typescript
// Prefer inject() over constructor injection
export class UserService {
  private http = inject(HttpClient);
  private baseUrl = inject(API_URL);
}
```

## Guidelines

- Favor Signals for local state and change detection optimization
- Use `inject()` function over constructor injection
- Leverage Control Flow Syntax for cleaner templates
- Follow official Angular Style Guide
- Use `ng generate` patterns for consistency
