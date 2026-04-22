---
name: angular-expert
description: "Deep expertise in Angular (v17+), including Signals, Hydration, and Standalone Components. Use when you need to: (1) build modern Angular applications, (2) implement Signals for state management, (3) optimize with SSR and Hydration, (4) create standalone components, (5) design reactive forms, or (6) write Angular tests with Jest/Playwright."
---

# Angular Development (v17+)

## Table of Contents
1. [Standalone Components](#standalone-components)
2. [Signals](#signals)
3. [Control Flow Syntax](#control-flow-syntax)
4. [Dependency Injection](#dependency-injection)
5. [SSR & Hydration](#ssr--hydration)
6. [Gotchas](#gotchas)
7. [Step-by-Step Workflows](#step-by-step-workflows)
8. [Assets & References](#assets--references)

---

## Standalone Components

Default to `standalone: true` for all new components, directives, and pipes.

```typescript
@Component({
  selector: 'app-user',
  standalone: true,
  imports: [CommonModule, RouterModule, UserCardComponent],
  template: `
    @if (user()) {
      <h1>{{ user().name }}</h1>
      <app-user-card [data]="user()" />
    }
  `
})
export class UserComponent {
  user = input.required<User>();
}
```

See `assets/standalone-component.template.ts` for a full scaffold.

---

## Signals

Use Signals for local and shared state. Prefer `signal()` / `computed()` / `input()` / `output()` over RxJS for synchronous UI state.

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

### Signal-Based Store Pattern

```typescript
@Injectable({ providedIn: 'root' })
export class CartStore {
  private items = signal<CartItem[]>([]);
  readonly total = computed(() =>
    this.items().reduce((sum, i) => sum + i.price, 0)
  );
  readonly count = computed(() => this.items().length);

  addItem(item: CartItem) {
    this.items.update(list => [...list, item]);
  }

  removeItem(id: string) {
    this.items.update(list => list.filter(i => i.id !== id));
  }
}
```

---

## Control Flow Syntax

Use the new built-in control flow instead of structural directives.

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

@switch (status()) {
  @case ('active') { <span>Active</span> }
  @case ('inactive') { <span>Inactive</span> }
  @default { <span>Unknown</span> }
}
```

---

## Dependency Injection

Always prefer `inject()` over constructor injection. It reduces boilerplate, works in constructors, lifecycle hooks, and functions.

```typescript
@Injectable({ providedIn: 'root' })
export class UserService {
  private http = inject(HttpClient);
  private baseUrl = inject(API_URL);
}
```

```typescript
@Component({...})
export class ProfileComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private service = inject(UserService);

  userId = toSignal(this.route.paramMap.pipe(map(p => p.get('id'))));

  ngOnInit() {
    // inject() can also be called here if needed
  }
}
```

See `assets/service-with-inject.template.ts` for a complete service scaffold.

---

## SSR & Hydration

Enable SSR for SEO and performance.

```typescript
// app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideClientHydration(withEventReplay()),
    provideHttpClient(withFetch()),
  ]
};
```

### Hydration Constraints
- DOM must match between server and client
- Direct DOM manipulation outside Angular lifecycle breaks hydration
- `afterNextRender()` and `afterRender()` are safe for manual DOM work post-hydration

```typescript
import { afterNextRender, ElementRef, Component, inject } from '@angular/core';

@Component({...})
export class ChartComponent {
  private el = inject(ElementRef);

  constructor() {
    afterNextRender(() => {
      // Safe to initialize third-party chart library here
      new ThirdPartyChart(this.el.nativeElement);
    });
  }
}
```

---

## Gotchas

### 1. Zone.js + Signals Interaction
Signals do not require Zone.js, but hybrid apps (signals + Zone.js) can behave unexpectedly. If a signal update does not trigger UI refresh:
- Ensure the update happens inside the Angular zone
- For async operations outside Angular (e.g., WebSocket callbacks), wrap updates in `NgZone.run()`

```typescript
private zone = inject(NgZone);

onExternalEvent(data: Data) {
  this.zone.run(() => {
    this.state.set(data);
  });
}
```

### 2. Object Mutation in Signals
Signals use referential equality by default. Mutating an object or array in place will not trigger updates.

```typescript
// BAD - no update detected
this.user.update(u => {
  u.name = 'New';
  return u;
});

// GOOD - new reference
this.user.update(u => ({ ...u, name: 'New' }));
this.items.update(list => [...list, newItem]);
```

### 3. Standalone vs NgModule Migration
- Standalone components cannot be declared in `declarations` arrays
- Third-party libraries still shipping NgModules must be imported into `imports: [TheirModule]`
- Lazy-loaded routes use `loadComponent` instead of `loadChildren`

```typescript
{
  path: 'profile',
  loadComponent: () => import('./profile.component').then(m => m.ProfileComponent)
}
```

### 4. effect() Without untracked() Causing Infinite Loops
Reading a signal inside `effect()` and then writing to it creates a cycle.

```typescript
// BAD - infinite loop
effect(() => {
  const current = this.count();
  this.count.set(current + 1);
});

// GOOD - untrack reads that should not subscribe the effect
import { effect, untracked } from '@angular/core';

effect(() => {
  const current = untracked(this.count);
  const other = this.otherSignal(); // this signal still tracks the effect
  this.count.set(current + other);
});
```

### 5. Hydration Issues with Third Parties
Libraries that manipulate the DOM before hydration completes will cause mismatches.
- Defer DOM manipulation until `afterNextRender()`
- For non-interactive content, consider `ngSkipHydration` as a last resort
- Ensure third-party scripts load after `DOMContentLoaded` or inside `afterNextRender()`

---

## Step-by-Step Workflows

### Workflow: Migrate a Component to Standalone

1. **Add `standalone: true`** to the component/directive/pipe decorator.
2. **Move imports** from the owning NgModule into the component's `imports` array.
3. **Remove** the component from any `declarations` array.
4. **Update consumers** to import the component directly instead of its module.
5. **Migrate providers**: if the module had `providers`, move them to `app.config.ts` or component-level `providers`.
6. **Run tests**: update `TestBed.configureTestingModule({ imports: [YourComponent] })`.
7. **Delete the module** once all declarations are migrated.

```typescript
// Before
@NgModule({
  declarations: [UserCardComponent],
  imports: [CommonModule],
  exports: [UserCardComponent]
})
export class UserCardModule {}

// After
@Component({
  selector: 'app-user-card',
  standalone: true,
  imports: [CommonModule],
  template: `...`
})
export class UserCardComponent {}
```

### Workflow: Create a Reusable Signals Store

1. Create an `@Injectable({ providedIn: 'root' })` service.
2. Declare private `signal()` properties.
3. Expose readonly derived state via `computed()`.
4. Expose mutation methods that update signals immutably.
5. Inject the store into components. Do not expose the writable signals directly.

---

## Guidelines

- Favor Signals for local state and change detection optimization.
- Use `inject()` function over constructor injection.
- Leverage Control Flow Syntax for cleaner templates.
- Follow official Angular Style Guide.
- Use `ng generate` patterns for consistency.
- Always `track` items in `@for` for performance.
- Prefer `withFetch()` for `HttpClient` in SSR apps.

---

## Assets & References

### Assets
- `assets/standalone-component.template.ts` - Full standalone component scaffold
- `assets/service-with-inject.template.ts` - Injectable service using `inject()`
- `assets/signals-directive.template.ts` - Standalone signals-based directive

### References
- `references/ngmodule-to-standalone-migration.md` - Detailed migration guide
- `references/state-management-comparison.md` - Signals vs NgRx vs NGXS etc.

### Scripts
- `scripts/audit-standalone.sh` - Audit project for remaining NgModule usage
