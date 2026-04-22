# NgModule to Standalone Migration Guide

## Overview
Angular v17+ favors standalone components. This guide covers migrating from NgModule-based architecture.

## Migration Strategy

### 1. Scaffold Standalone Components
- Remove `NgModule` from new components
- Add `standalone: true` to `@Component` / `@Directive` / `@Pipe`
- Explicitly import dependencies in `imports: [...]`

### 2. Convert Existing Components (Bottom-Up)
Start with leaf components (lowest dependency count) and move upward.

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

### 3. Replace Module Imports with Direct Component Imports
```typescript
// Before
imports: [UserCardModule]

// After
imports: [UserCardComponent]
```

### 4. Bootstrap Application
```typescript
// main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

bootstrapApplication(AppComponent, appConfig)
  .catch(err => console.error(err));
```

### 5. Handle Providers
Move module providers to `app.config.ts`:

```typescript
import { ApplicationConfig } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(withFetch()),
    // Other global providers
  ]
};
```

## Common Pitfalls
- **Lazy loading**: Use `loadComponent` instead of `loadChildren` for standalone routes
- **Third-party libraries**: Some still require `NgModule` imports; wrap or shim if needed
- **Testing**: Update `TestBed.configureTestingModule` to `TestBed.configureTestingModule({ imports: [StandaloneComponent] })`

## Verification Checklist
- [ ] No `declarations` arrays remain in app code
- [ ] `bootstrapApplication` used in `main.ts`
- [ ] `provideHttpClient` used instead of `HttpClientModule`
- [ ] `provideRouter` used instead of `RouterModule.forRoot`
- [ ] All components use `standalone: true`
