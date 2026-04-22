# Angular State Management Comparison

## Signals (Built-in, v16+)
**Best for**: Local / component-level state, medium complexity apps

**Pros**:
- Zero dependency
- Fine-grained reactivity
- Excellent Angular integration
- Automatic cleanup

**Cons**:
- No built-in devtools
- Manual side-effect handling (`effect()`)
- Cross-component sharing requires service layer

**Pattern**:
```typescript
@Injectable({ providedIn: 'root' })
export class CartStore {
  private items = signal<CartItem[]>([]);
  readonly total = computed(() => this.items().reduce((sum, i) => sum + i.price, 0));

  addItem(item: CartItem) {
    this.items.update(items => [...items, item]);
  }
}
```

## NgRx / Redux
**Best for**: Large teams, strict unidirectional data flow, time-travel debugging

**Pros**:
- Mature devtools
- Strict architecture
- Excellent for complex async flows

**Cons**:
- Significant boilerplate
- Steep learning curve
- Overkill for simple state

## NGXS
**Best for**: Medium-to-large apps wanting less boilerplate than NgRx

**Pros**:
- Less boilerplate than NgRx
- Type-safe actions via decorators
- Good devtools

**Cons**:
- Smaller community than NgRx
- Magic via decorators can confuse debugging

## RxJS BehaviorSubject (DIY)
**Best for**: Legacy apps, custom solutions

**Pros**:
- Full control
- Works everywhere

**Cons**:
- Manual subscription management
- No built-in change detection optimization
- Easy to create memory leaks

## Akita / Elf
**Best for**: Opinionated store with less boilerplate

**Pros**:
- Minimal boilerplate
- Entity management built-in

**Cons**:
- Smaller ecosystem
- Risk of abandonment (Akita maintenance slowed)

## Recommendation Matrix
| Scenario | Recommendation |
|----------|---------------|
| Small app (< 20 components) | Signals only |
| Medium app, simple state | Signals + services |
| Medium app, complex async | Signals or NGXS |
| Large enterprise app | NgRx or NGXS |
| Legacy migration | Signals gradually |
