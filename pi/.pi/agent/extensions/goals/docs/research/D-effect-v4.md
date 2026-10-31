# D. Effect 4 reference for a stateful service (installed 4.0.0-beta.98)

Scope: the Effect version actually installed in this repo, verified against its own
`.d.ts` and runtime. Everything below was checked on disk; nothing is quoted from memory.
Scratch probes live in `/tmp/effect-probe` and only this file was written in the project.

Sources inspected:

| Source | Path |
| --- | --- |
| Package manifest | `/home/nacho/.pi/agent/node_modules/effect/package.json` (symlink to `/home/nacho/dotfiles/pi/.pi/agent/node_modules`) |
| Type declarations | `/home/nacho/.pi/agent/node_modules/effect/dist/*.d.ts` (138 top-level modules) |
| Runtime exports | `node --input-type=module -e "import(...effect/dist/Effect.js)"` key dumps |
| Existing repo usage | `extensions/git-info/src/{runtime,process,refresh-coordinator}.ts`, `extensions/background-terminals/src/*`, `extensions/git-info/*.test.ts` |
| Compile probe | `/tmp/effect-probe` (TypeScript 7.0.2 from the npx cache) |

## 0. Version facts and upgrade advice

Installed (`package.json` of the package, and `/home/nacho/.pi/agent/package.json` pins it there):

```
version: 4.0.0-beta.98
type: module
exports:
  ".": "./dist/index.js"
  "./testing": "./dist/testing/index.js"
  "./unstable/*": "./dist/unstable/*/index.js"
  "./*": "./dist/*.js"
  "./*/index": null
  "./internal/*": null
```

Published versions (npm, checked at research time):

```
$ npm view effect version
4.1.1

$ npm view effect dist-tags --json
{
  "snapshot": "0.0.0-snapshot-6ebc752baf28354006ca2a0ae783a5bccf5de9ad",
  "beta": "4.0.0-beta.107",
  "rc": "4.0.0-rc.118",
  "prev": "3.22.4",
  "latest": "4.1.1",
  "staging": "4.1.1"
}

$ npm view effect versions --json | tail -30
... "4.0.0-beta.105", "4.0.0-beta.106", "4.0.0-beta.107",
    "4.0.0-rc.108" ... "4.0.0-rc.118",
    "4.0.0", "4.0.1", "4.0.2", "4.0.3", "4.0.4", "4.0.5", "4.0.6", "4.0.7",
    "4.1.0", "4.1.1"
```

**4.0.0-beta.98 is not the newest 4.x.** It is 9 betas, 11 RCs and 10 releases behind 4.1.1.

**Upgrade now: no.** Verified reasons:

1. `@effect/platform-node` is pinned to `4.0.0-beta.98` in `/home/nacho/.pi/agent/package.json`
   and in `overrides` together with `@effect/platform`. Bumping `effect` alone desynchronizes them.
2. The API moved between beta.98 and 4.1.1. Concrete diff, `npm pack effect@4.1.1` into `/tmp/effect-411`:
   - `Schema.TaggedErrorClass` exists in beta.98 and is **gone** in 4.1.1; 4.1.1 exports `Schema.TaggedError`.
   - `SchemaError` is its own module in beta.98 (`effect/SchemaError`); in 4.1.1 that module is gone and
     the class is exported from `Schema.d.ts` (`export declare class SchemaError`).
   - Modules added in 4.1.1: `Arbitrary`, `Bytes`, `ByteSize`, `Glob`, `SemVer`, `SemVerRange`, `StandardSchema`.
   - Modules removed in 4.1.1: `Crypto`, `Encoding`, `SchemaError`, `SchemaUtils`.
   - Unchanged in 4.1.1: `Context.Service` (still no `Context.Tag`), `Effect.catch` (no `catchAll`),
     `Effect.forkChild/forkScoped` (no `fork`), `Layer.effect` (no `Layer.scoped`), `decodeUnknownResult`.
3. The repo cannot currently typecheck at all, so an upgrade could not be validated: `typescript` is
   declared as `^7.0.2` in devDependencies but is not installed (`ls node_modules/typescript` fails,
   `npm run check` prints `sh: line 1: tsc: command not found`).

So the target for the goals extension is the beta.98 API documented here. Upgrade would be a
coordinated bump of `effect`, `@effect/platform`, `@effect/platform-node` and the `overrides` block,
followed by the renamed-error changes above.

## 1. Imports: what actually exists

Two import styles work. The barrel is `effect`; the per-module subpaths resolve through
`"./*": "./dist/*.js"`.

```ts
import { Context, Effect, Layer, Ref, Schema, Semaphore, SynchronizedRef } from "effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
```

Verified runtime resolution:

```
effect            -> 144 named exports
effect/Effect     -> 226 named exports
effect/index      -> resolves to dist/index.js (works: the "./*" pattern matches)
effect/Schema/index -> ERR_PACKAGE_PATH_NOT_EXPORTED ("./*/index": null)
effect/internal/effect -> ERR_PACKAGE_PATH_NOT_EXPORTED ("./internal/*": null)
effect/testing    -> TestClock, TestConsole, TestSchema, FastCheck
```

Real top-level subpaths (`ls /home/nacho/.pi/agent/node_modules/effect/dist/*.d.ts`, 138 modules,
`index` excluded because it is the barrel):

```
Array BigDecimal BigInt Boolean Brand Cache Cause Channel ChannelSchema Chunk Clock Combiner Config
ConfigProvider Console Context Cron Crypto Data DateTime Deferred Differ Duration Effect Effectable
Encoding Equal Equivalence ErrorReporter ExecutionPlan Exit Fiber FiberHandle FiberMap FiberSet
FileSystem Filter Formatter Function Graph Hash HashMap HashRing HashSet HKT Inspectable Iterable
JsonPatch JsonPointer JsonSchema Latch Layer LayerMap LayerRef Logger LogLevel ManagedRuntime Match
Metric MutableHashMap MutableHashSet MutableList MutableRef Newtype NonEmptyIterable Number Optic
Option Order Ordering PartitionedSemaphore Path Pipeable PlatformError Pool Predicate PrimaryKey
PubSub Pull Queue Random RcMap RcRef Record Redactable Redacted Reducer Ref References RegExp
Request RequestResolver Resource Result Runtime Schedule Scheduler Schema SchemaAST SchemaError
SchemaGetter SchemaIssue SchemaParser SchemaRepresentation SchemaTransformation SchemaUtils Scope
ScopedCache ScopedRef Semaphore Sink Stdio Stream String Struct SubscriptionRef Symbol
SynchronizedRef Take Terminal Tracer Trie Tuple TxChunk TxDeferred TxHashMap TxHashSet
TxPriorityQueue TxPubSub TxQueue TxReentrantLock TxRef TxSemaphore TxSubscriptionRef Types
UndefinedOr Unify Utils
```

Plus the directory exports: `effect/testing`, and `effect/unstable/{ai,cli,cluster,devtools,encoding,eventlog,http,httpapi,observability,persistence,process,reactivity,rpc,schema,socket,sql,workflow,workers}`.

These subpaths **do not exist** and must not be imported: `effect/internal/*` and `effect/*/index`
(e.g. `effect/Schema/index`), both blocked by `null` entries in `exports`. `effect/Semaphore` and
`effect/SynchronizedRef` do exist; the barrel namespaces `Semaphore` and `SynchronizedRef` are the
same modules.

Typecheck of the subpath imports (real output):

```
$ cd /tmp/effect-probe && node .../typescript/bin/tsc --ignoreConfig --noEmit --strict \
    --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --types node subpaths.ts
EXIT=0
```

## 2. Building effects: gen / sync / try / tryPromise / fn / fnUntraced

Copied from `dist/Effect.d.ts`:

```ts
// Effect.gen, overload 1 (line 1778)
<Eff extends Effect<any, any, any>, AEff>(f: () => Generator<Eff, AEff, never>): Effect<AEff, [
    Eff
] extends [never] ? never : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E : never, [
    Eff
] extends [never] ? never : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R : never>;

// Effect.sync (line 1412)
export declare const sync: <A>(thunk: LazyArg<A>) => Effect<A>;

// Effect.try (line 2014, exported as `try`)
declare const try_: <A, E = Cause.UnknownError>(options: {
    readonly try: LazyArg<A>;
    readonly catch: (error: unknown) => E;
} | LazyArg<A>) => Effect<A, E>;

// Effect.tryPromise (line 1222)
export declare const tryPromise: <A, E = Cause.UnknownError>(options: {
    readonly try: (signal: AbortSignal) => PromiseLike<A>;
    readonly catch: (error: unknown) => E;
} | ((signal: AbortSignal) => PromiseLike<A>)) => Effect<A, E>;

// Effect.promise (line 1151) — note the AbortSignal argument
export declare const promise: <A>(evaluate: (signal: AbortSignal) => PromiseLike<A>) => Effect<A>;

// Effect.fnUntraced (line 17522), Effect.fn (line 17640)
export declare const fnUntraced: fn.Untraced;
export declare const fn: fn.Traced & {
    (name: string, options?: SpanOptionsNoTrace): fn.Traced;
};

// Effect.gen, overload 2: `this` binding (line 1827)
<Self, Eff extends Effect<any, any, any>, AEff>(options: {
    readonly self: Self;
}, f: (this: Self) => Generator<Eff, AEff, never>): Effect<AEff, ...>;
```

What compiles under TypeScript 7.0.2 + ESM + `verbatimModuleSyntax` (all verified in
`/tmp/effect-probe/probe7.ts`, `EXIT=0`):

| Form | Compiles | Notes |
| --- | --- | --- |
| `Effect.gen(function* () { return 1 })` | yes | Zero `yield*` is allowed; `Eff` becomes `never` |
| `Effect.gen(function* () { const n = yield* Effect.succeed(1); return n })` | yes | `yield*` requires an `Effect`; yielding a plain value is a type error |
| `Effect.fn(function* (n: number) { ... })` | yes | Unnamed form; no span |
| `Effect.fn("name")(function* (n: number) { ... })` | yes | Creates a span when run |
| `Effect.fnUntraced(function* (n: number) { ... })` | yes | No span, no stack frame |
| `Effect.fn("C.x")({ self: this }, function* (this: C, ...) {})` | yes | Required for `this` binding |
| Annotating a generator body | yes | `function* (): Generator<Effect.Effect<number>, number, never>` |
| `Effect.gen({ self: this }, function* (this: C) { ... })` | yes | Effect 4 form of `this` binding |
| `Effect.gen(this, function* () { ... })` | **no** | Effect 3 form; `TS2554: Expected 1-2 arguments, but got 3` |
| `import { type Effect } from "effect"` then `Effect.Effect<A, E, R>` | yes | This is what the repo does under `verbatimModuleSyntax` (see `extensions/git-info/src/runtime.ts`) |

Behavioral notes verified at runtime:

- `Effect.gen` bodies are lazy; nothing runs until a runner (`runSync` / `runPromise` / `runFork` / `ManagedRuntime`) runs it.
- `Effect.fn` and `Effect.fnUntraced` return ordinary functions that build an `Effect` per call; both run fine (`fn: 4 3`).
- `Effect.try` and `Effect.tryPromise` default `E` to `Cause.UnknownError` when the thunk form is used
  (no `catch`); pass `{ try, catch }` to get your own error type.

## 3. Schema in beta.98

Verified names (`typeof` checked at runtime, declarations checked in `dist/Schema.d.ts`):

```ts
export declare function Struct<const Fields extends Struct.Fields>(fields: Fields): Struct<Fields>;
export declare function Union<const Members extends ReadonlyArray<Constraint>>(members: Members, options?: {
    mode?: "anyOf" | "oneOf";
}): Union<Members>;
export declare function Literals<const L extends ReadonlyArray<SchemaAST.LiteralValue>>(literals: L): Literals<L>;
export declare const optional: optionalLambda;          // optional key + optional value
export declare const optionalKey: optionalKeyLambda;    // optional key only

export declare function decodeUnknownSync<S extends ConstraintDecoder<unknown>>(schema: S, options?: SchemaAST.ParseOptions): (input: unknown, options?: SchemaAST.ParseOptions) => S["Type"];
export declare function decodeUnknownResult<S extends ConstraintDecoder<unknown>>(schema: S, options?: SchemaAST.ParseOptions): (input: unknown, options?: SchemaAST.ParseOptions) => Result_.Result<S["Type"], SchemaError>;
export declare const decodeUnknownOption: <S extends ConstraintDecoder<unknown>>(schema: S, options?: SchemaAST.ParseOptions) => (input: unknown, options?: SchemaAST.ParseOptions) => Option_.Option<S["Type"]>;
export declare function decodeUnknownEffect<S extends Constraint>(schema: S, options?: SchemaAST.ParseOptions): (input: unknown, options?: SchemaAST.ParseOptions) => Effect.Effect<S["Type"], SchemaError, S["DecodingServices"]>;
export declare const encodeSync: <S extends ConstraintEncoder<unknown>>(schema: S, options?: SchemaAST.ParseOptions) => (input: S["Type"], options?: SchemaAST.ParseOptions) => S["Encoded"];
export declare function fromJsonString<S extends Constraint>(schema: S): fromJsonString<S>;
export declare function check<S extends Top>(...checks: readonly [SchemaAST.Check<S["Type"]>, ...Array<SchemaAST.Check<S["Type"]>>]): (self: S) => S["Rebuild"];

// Tagged errors: this is the beta.98 name
export declare const TaggedErrorClass: {
    <Self = never, Brand = {}>(identifier?: string): {
        <Tag extends string, const Fields extends Struct.Fields>(tag: Tag, fields: Fields, annotations?: ...):
            [Self] extends [never] ? MissingSelfGeneric<"Schema.TaggedErrorClass"> : Class<Self, TaggedStruct<Tag, Fields>, Cause_.YieldableError & Brand>;
        <Tag extends string, S extends Struct<Struct.Fields>>(tag: Tag, schema: S, annotations?: ...): ...;
    };
};
```

Presence check of every name in the task list:

| Name | beta.98 | Correct call |
| --- | --- | --- |
| `Schema.Struct` | present (function) | `Schema.Struct({ ... })` |
| `Schema.Union` | present (function) | `Schema.Union([A, B])` |
| `Schema.Literals` | present | `Schema.Literals([1, 2])` |
| `Schema.Literal` | present (single value) | `Schema.Literal("a")` |
| `Schema.optional` | present | `Schema.optional(Schema.String)` |
| `Schema.decodeUnknownSync` | present | throws `SchemaError` |
| `Schema.encodeSync` | present | `Schema.encodeSync(S)` |
| `Schema.decodeUnknownOption` | present | returns `Option<A>` |
| `Schema.decodeUnknownEither` | **removed** | use `Schema.decodeUnknownResult` (`Result<A, SchemaError>`) or `decodeUnknownExit` |
| `Schema.fromJsonString` | present | `Schema.fromJsonString(Snapshot)` |
| `Schema.Finite` | present | schema value |
| `Schema.Int` | present | schema value |
| `Schema.DateFromString` | present | decodes ISO string to `Date` (verified: `v1.updatedAt instanceof Date`) |
| `Schema.TaggedError` | **removed** | use `Schema.TaggedErrorClass` |
| `Schema.TaggedErrorClass` | present | class factory, see example |
| `Schema.filter` / `Schema.transform` / `Schema.transformOrFail` | **removed** | `Schema.check(...)`, `Schema.decodeTo(...)`, `Schema.makeFilter(...)` |
| `Schema.optionalWith` / `Schema.propertySignature` / `Schema.extend` / `Schema.intersect` / `Schema.pick` / `Schema.omit` | **removed** | declare fields explicitly |
| `Schema.mutable`, `Schema.Class`, `Schema.TaggedClass`, `Schema.TaggedStruct`, `Schema.TaggedUnion`, `Schema.toTaggedUnion` | present | |

Validation error shape (`SchemaError.d.ts`):

```ts
export declare class SchemaError extends SchemaError_base<{
    readonly issue: Issue;
}> {
    get message(): string;
    toString(): string;
}
export declare function isSchemaError(u: unknown): u is SchemaError;
```

Real message from a failed decode:

```
Expected 1 | 2, got 3
  at ["v"]
```

So `error.message` is the human string; the structured data is `error.issue`.

`Schema.decodeUnknownResult` returns `Result`; `result._tag` is `"Success" | "Failure"` and
`result.failure` is a `SchemaError`. `Schema.decodeUnknownSync` throws it.

Working schema shape for a versioned snapshot (compiled and exercised in the example below):

```ts
const SnapshotV1 = Schema.Struct({
  version: Schema.Literals([1]),
  count: Schema.Int,
  updatedAt: Schema.DateFromString,
})
const SnapshotV2 = Schema.Struct({
  version: Schema.Literals([2]),
  count: Schema.Int,
  note: Schema.optional(Schema.String),
  updatedAt: Schema.DateFromString,
})
export const Snapshot = Schema.Union([SnapshotV1, SnapshotV2])
export type Snapshot = typeof Snapshot.Type
export const SnapshotJson = Schema.fromJsonString(Snapshot)   // string <-> Snapshot
```

Tagged error:

```ts
class SnapshotDecodeError extends Schema.TaggedErrorClass<SnapshotDecodeError>()(
  "SnapshotDecodeError",
  { message: Schema.String, input: Schema.Unknown },
) {}
```

`Schema.TaggedErrorClass` produces a class that is a yieldable error (has `_tag`, extends `Cause.YieldableError`),
so `yield* new SnapshotDecodeError(...)` / `Effect.fail(new ...)` both work and `Effect.catchTag("SnapshotDecodeError", ...)` narrows.

## 4. State: Ref, SynchronizedRef, Semaphore

All three modules exist and are also exposed on the barrel (`Ref`, `SynchronizedRef`, `Semaphore`).

```ts
// Ref.d.ts
export interface Ref<in out A> extends Ref.Variance<A>, Pipeable { ... }
export declare const make: <A>(value: A) => Effect.Effect<Ref<A>>;
export declare const makeUnsafe: <A>(value: A) => Ref<A>;
export declare const get: <A>(self: Ref<A>) => Effect.Effect<A, never, never>;
export declare const set: (<A>(value: A) => (self: Ref<A>) => Effect.Effect<void>) & (<A>(self: Ref<A>, value: A) => Effect.Effect<void>);
export declare const update: (<A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<void>) & (<A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<void>);
export declare const modify: (<A, B>(f: (a: A) => readonly [B, A]) => (self: Ref<A>) => Effect.Effect<B>) & (<A, B>(self: Ref<A>, f: (a: A) => readonly [B, A]) => Effect.Effect<B>);
export declare const getAndSet: ...;
export declare const updateAndGet: ...;
```

Note `makeUnsafe`, not Effect 3's `unsafeMake`.

`Ref.modify` is atomic for the update itself (its function is pure, cannot fail or suspend), so for
a pure state transition `Ref.modify` is already serialized and needs no lock.

```ts
// SynchronizedRef.d.ts
export interface SynchronizedRef<in out A> extends Ref.Ref<A> { ... }
export declare const make: <A>(value: A) => Effect.Effect<SynchronizedRef<A>>;
export declare const makeUnsafe: <A>(value: A) => SynchronizedRef<A>;
export declare const modifyEffect: {
    <A, B, E, R>(f: (a: A) => Effect.Effect<readonly [B, A], E, R>): (self: SynchronizedRef<A>) => Effect.Effect<B, E, R>;
    <A, B, E, R>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<readonly [B, A], E, R>): Effect.Effect<B, E, R>;
};
export declare const set: ...; export declare const get: ...; export declare const updateEffect: ...;
```

`SynchronizedRef` is the Effect 4 answer for "serialize all mutations of one piece of state": it is a
`Ref` with an internal lock, and `modifyEffect` runs an effectful transition atomically (read, decide,
maybe fail, write) while holding that lock. This is what the example uses.

```ts
// Semaphore.d.ts
export interface Semaphore {
    withPermits(this: Semaphore, permits: number): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    withPermit<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
    withPermitsIfAvailable(this: Semaphore, permits: number): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
    release(this: Semaphore, permits: number): Effect.Effect<number>;
    readonly releaseAll: Effect.Effect<number>;
}
export declare const make: (permits: number) => Effect.Effect<Semaphore>;
export declare const makeUnsafe: (permits: number) => Semaphore;
```

There is no `Mutex` module in beta.98. `Semaphore.makeUnsafe(1)` is the mutex.

Runtime check that it really serializes (5 effects, `concurrency: "unbounded"`):

```
semaphore maxInFlight = 1 order = 1,2,3,4,5
```

Decision rule used in the report's example:

- one ref, one atomic transition -> `SynchronizedRef.modifyEffect`
- several refs, or decode + write + side effect must be one critical section -> `Semaphore.makeUnsafe(1).withPermit(...)`
- read-only access -> `Ref.get` on either type

`Semaphore` is not on `Effect` (no `Effect.Semaphore`); import it from `effect` or `effect/Semaphore`.
`PartitionedSemaphore` and `TxSemaphore` also exist in this version if ever needed.

## 5. Services and Layers

Effect 4 beta.98 has **`Context.Service`**; `Context.Tag`, `Context.GenericTag` and `Effect.Service` do **not**
exist (`Object.keys(Context)` = `Reference Service ServiceTypeId add addOrOmit empty get getOption
getOrElse getOrUndefined getReferenceUnsafe getUnsafe isContext isKey isReference make makeUnsafe merge
mergeAll mutate omit pick`).

```ts
// Context.d.ts, line 186
export declare const Service: {
    <Identifier, Shape = Identifier>(key: string): Service<Identifier, Shape>;
    <Self, Shape>(): <const Identifier extends string, E, R = Types.unassigned, Args extends ReadonlyArray<any> = never>(id: Identifier, options?: {
        readonly make: ((...args: Args) => Effect<Shape, E, R>) | Effect<Shape, E, R> | undefined;
    } | undefined) => ServiceClass<Self, Identifier, Shape> & (...);
    <Self>(): <const Identifier extends string, Make extends Effect<any, any, any> | ((...args: any) => Effect<any, any, any>)>(id: Identifier, options: {
        readonly make: Make;
    }) => ServiceClass<Self, ...> & { readonly make: Make };
};
```

Two styles, both verified:

```ts
// function style: the value type is the service type
const Logger = Context.Service<{ log: (m: string) => Effect.Effect<void> }>("Logger")

// class style: first generic is the self type, second the shape
class Counter extends Context.Service<Counter, CounterShape>()("Counter") {}
```

`ServiceClass` has `key` and the `Service` phantom type; it has **no `.of` helper** (that was `Effect.Service` in
Effect 3). Build the shape as a plain object typed by the interface.

Layer constructors (copied from `Layer.d.ts`):

```ts
export declare const succeed: {
    <I, S>(service: Context.Key<I, S>): (resource: S) => Layer<I>;
    <I, S>(service: Context.Key<I, S>, resource: Types.NoInfer<S>): Layer<I>;
};
export declare const effect: {
    <I, S>(service: Context.Key<I, S>): <E, R>(effect: Effect<S, E, R>) => Layer<I, E, Exclude<R, Scope.Scope>>;
    <I, S, E, R>(service: Context.Key<I, S>, effect: Effect<Types.NoInfer<S>, E, R>): Layer<I, E, Exclude<R, Scope.Scope>>;
};
export declare const effectContext: <A, E, R>(effect: Effect<Context.Context<A>, E, R>) => Layer<A, E, Exclude<R, Scope.Scope>>;
export declare const build: <RIn, E, ROut>(self: Layer<ROut, E, RIn>) => Effect<Context.Context<ROut>, E, RIn | Scope.Scope>;
export declare const mergeAll: <Layers extends [Layer<never, any, any>, ...Array<Layer<never, any, any>>]>(...layers: Layers) => Layer<Success<Layers[number]>, Error<Layers[number]>, Services<Layers[number]>>;
export declare const provide: {
    <RIn, E, ROut>(that: Layer<ROut, E, RIn>): <RIn2, E2, ROut2>(self: Layer<ROut2, E2, RIn2>) => Layer<ROut2, E | E2, RIn | Exclude<RIn2, ROut>>;
    <const Layers extends [Any, ...Array<Any>]>(that: Layers): <A, E, R>(self: Layer<A, E, R>) => Layer<A, E | Error<Layers[number]>, Services<Layers[number]> | Exclude<R, Success<Layers[number]>>>;
    // plus data-first overloads
};
```

**`Layer.scoped` does not exist.** `Layer.effect` already runs its effect in the layer's scope and
strips `Scope` from the requirements (`Exclude<R, Scope.Scope>`), so
`Layer.effect(Tag, Effect.gen(function* () { const h = yield* Effect.acquireRelease(...); ... }))`
is the scoped-layer recipe. `Layer.succeed` is for already-built values.

`Effect.provide` accepts a layer, a tuple of layers, or a `Context`:

```ts
export declare const provide: {
    <const Layers extends [Layer.Any, ...Array<Layer.Any>]>(layers: Layers, options?: { readonly local?: boolean }): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | Layer.Error<Layers[number]>, Layer.Services<Layers[number]> | Exclude<R, Layer.Success<Layers[number]>>>;
    <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>, options?: { readonly local?: boolean }): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, RIn | Exclude<R, ROut>>;
    <R2>(context: Context.Context<R2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, R2>>;
    // plus data-first overloads
};
```

Consuming a service: `const svc = yield* Counter` inside `Effect.gen`. Because `Service` extends
`Key` extends `Effect<Shape, never, Identifier>`, a tag is itself an effect that resolves from context.

Verified pattern (`/tmp/effect-probe/example.ts`, tsc clean, tests green):

```ts
export const CounterLive = Layer.effect(Counter, Effect.gen(function* () {
  const state = yield* SynchronizedRef.make<Snapshot>(initial)
  const shape: CounterShape = { increment: ..., read: Ref.get(state), restore: ... }
  return shape
}))

export const main = program.pipe(Effect.provide(CounterLive))
```

`Layer.mergeAll(LA, LB)` and `SomeLive.pipe(Layer.provide(DepsLayer))` both work; the repo uses the
latter in `extensions/git-info/src/runtime.ts`:

```ts
const AppLayer = CommandRunnerLive.pipe(Layer.provide(NodeServices.layer))
```

## 6. Running effects from plain TS (Pi extension event handlers)

Verified runner signatures:

```ts
export declare const runSync: <A, E>(effect: Effect<A, E>) => A;
export declare const runSyncExit: <A, E>(effect: Effect<A, E>) => Exit.Exit<A, E>;
export declare const runPromise: <A, E>(effect: Effect<A, E>, options?: RunOptions) => Promise<A>;
export declare const runPromiseExit: <A, E>(effect: Effect<A, E>, options?: RunOptions) => Promise<Exit.Exit<A, E>>;
export declare const runFork: <A, E>(effect: Effect<A, E, never>, options?: RunOptions) => Fiber<A, E>;
export declare const runCallback: ...;
```

`ManagedRuntime` (`dist/ManagedRuntime.d.ts`):

```ts
export declare const make: <R, ER>(layer: Layer.Layer<R, ER, never>, options?: {
    readonly memoMap?: Layer.MemoMap | undefined;
} | undefined) => ManagedRuntime<R, ER>;

export interface ManagedRuntime<in R, out ER> {
    readonly contextEffect: Effect.Effect<Context.Context<R>, ER>;
    readonly context: () => Promise<Context.Context<R>>;
    readonly scope: Scope.Closeable;
    readonly runFork: <A, E>(self: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Fiber.Fiber<A, E | ER>;
    readonly runSyncExit: <A, E>(effect: Effect.Effect<A, E, R>) => Exit.Exit<A, ER | E>;
    readonly runSync: <A, E>(effect: Effect.Effect<A, E, R>) => A;
    readonly runCallback: <A, E>(effect: Effect.Effect<A, E, R>, options?: ...) => (interruptor?: number | undefined) => void;
    readonly runPromise: <A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Promise<A>;
    readonly runPromiseExit: <A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Promise<Exit.Exit<A, ER | E>>;
    readonly dispose: () => Promise<void>;
    readonly disposeEffect: Effect.Effect<void, never, never>;
}
```

Measured behavior (probe4/probe6):

| Runner | Behavior |
| --- | --- |
| `Effect.runSync(Effect.succeed(5))` | returns `5` |
| `Effect.runSync(Effect.fail("bad"))` | throws the bare value `"bad"` |
| `Effect.runSync(Effect.die(new Error("boom")))` | throws the defect |
| `Effect.runSync(Effect.sleep(1))` | throws `AsyncFiberError` (`_tag: 'AsyncFiberError'`) because the effect is async |
| `Effect.runPromise(Effect.fail("typed"))` | rejects with `"typed"` |
| `Effect.runPromise(Effect.die(err))` | rejects with `err` |
| `Effect.runPromiseExit(...)` | always resolves, with `Exit.Success` or `Exit.Failure` (defects included) |
| `ManagedRuntime.runPromiseExit` | same, and includes layer-construction errors in `E` |

Which is safe per event:

- **Recommended: one `ManagedRuntime` per extension, built once**, then `runtime.runPromiseExit(...)`
  (or `runPromise` with a try/catch) per event. The layer is built once and reused, and `dispose()` on
  shutdown releases scoped resources. This is what `extensions/git-info/src/runtime.ts` and
  `extensions/background-terminals/src/runtime.ts` do (`ManagedRuntime.make(AppLayer)` + `runEffect` helper).
- `Effect.runPromiseExit` per event is also safe but rebuilds the layer every call, so any `Ref` inside
  it resets and any scoped resource is acquired again. Only use it for stateless effects.
- `Effect.runSync` is only safe for effects that are known synchronous (`Ref.modify`, pure transforms).
  Treat an `AsyncFiberError` as a bug, not a retry case.
- Never call a runner in a hot loop; keep one runtime and interrupt per-event fibers on session shutdown.

## 7. Errors: narrow channels and defect-vs-failure

```ts
export declare const catch: {
    <E, A2, E2, R2>(f: (e: E) => Effect<A2, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A2 | A, E2, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, f: (e: E) => Effect<A2, E2, R2>): Effect<A2 | A, E2, R2 | R>;
};
export declare const catchTag: {
    <const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>, ...>(k: K, f: (e: ExtractTag<...>) => Effect<A1, E1, R1>, orElse?: ((e: ExcludeTag<...>) => Effect<A2, E2, R2>) | undefined): <A, R>(self: Effect<A, E, R>) => Effect<...>;
    // plus data-first overload
};
export declare const mapError: {
    <E, E2>(f: (e: E) => E2): <A, R>(self: Effect<A, E, R>) => Effect<A, E2, R>;
    <A, E, R, E2>(self: Effect<A, E, R>, f: (e: E) => E2): Effect<A, E2, R>;
};
export declare const orElseSucceed: {
    <A2>(evaluate: LazyArg<A2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A2 | A, never, R>;
    <A, E, R, A2>(self: Effect<A, E, R>, evaluate: LazyArg<A2>): Effect<A | A2, never, R>;
};
export declare const exit: <A, E, R>(self: Effect<A, E, R>) => Effect<Exit.Exit<A, E>, never, R>;
export declare const catchCause: ...;       // replaces Effect 3 catchAllCause
export declare const catchDefect: ...;
export declare const catchIf: ...; export declare const catchFilter: ...;
export declare const tapError: ...; export declare const tapErrorTag: ...;
```

`Effect.catchAll` is gone; the general handler is `Effect.catch`. Verified missing at runtime:
`catchAll`, `catchAllCause`, `catchSome`.

`Cause` (`dist/Cause.d.ts`):

```ts
export declare const pretty: <E>(cause: Cause<E>) => string;
export declare const squash: <E>(self: Cause<E>) => unknown;
export declare const prettyErrors: ...;   // present
export declare const hasFails: ...; export declare const hasDies: ...; export declare const hasInterruptsOnly: ...;
export declare const findErrorOption: ...; export declare const findDefect: ...;
```

Removed: `Cause.failures`, `Cause.defects`, `Cause.isEmpty`, `Cause.isFailure`, `Cause.isDie`, `Cause.flipCauseOption`.

Typed failure vs defect, measured:

```
isFailure: true | hasDies: true | hasFails: false | squash: defect
```

Rules that keep errors narrow:

1. Give every service method an explicit `Effect<A, SpecificError>` return type in the interface; do not
   let `SchemaError`, `unknown`, or `never` leak into the service signature.
2. Convert at the boundary: `Schema.decodeUnknownEffect` fails with `SchemaError`; wrap once with
   `Effect.mapError((error) => new SnapshotDecodeError({ message: error.message, input }))`.
3. In host code, branch on `Exit`: `Exit.isSuccess(exit)` vs `Exit.isFailure(exit)`, then
   `Exit.findErrorOption(exit)` for typed failures and `Cause.hasDies(exit.cause)` for defects.
   Note `Exit.findError` returns `Result<E, Exit<A, E>>`, whose `_tag` collides with a tagged error's
   `_tag`; prefer `findErrorOption` + `Option.isSome`.
4. Use `Effect.die` only for broken invariants; use `Schema.TaggedErrorClass` classes for anything a caller
   can handle. `Cause.squash` throws the first defect or error and is for logging, not control flow.

## 8. Scope, resources, shutdown

```ts
export declare const scoped: <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Scope>>;
export declare const acquireRelease: <A, E, R, R2>(acquire: Effect<A, E, R>, release: (a: A, exit: Exit.Exit<unknown, unknown>) => Effect<unknown, never, R2>, options?: {
    readonly interruptible?: boolean;
}) => Effect<A, E, R | R2 | Scope>;
export declare const acquireUseRelease: <Resource, E, R, A, E2, R2, E3, R3>(acquire, use, release) => Effect<A, E | E2 | E3, R | R2 | R3>;
export declare const addFinalizer: <R>(finalizer: (exit: Exit.Exit<unknown, unknown>) => Effect<void, never, R>) => Effect<void, never, R | Scope>;
export declare const ensuring: { ... };
export declare const scope: Effect<Scope, never, Scope>;
export declare const scopedWith: <A, E, R>(f: (scope: Scope) => Effect<A, E, R>) => Effect<A, E, R>;
export declare const acquireDisposable: <A extends AsyncDisposable | Disposable, E, R>(acquire: Effect<A, E, R>) => Effect<A, E, R | Scope>;
```

`Scope` module: `Scope.make`, `Scope.makeUnsafe`, `Scope.addFinalizer`, `Scope.addFinalizerExit`,
`Scope.close`, `Scope.use`, `Scope.provide`, `Scope.fork`.

Finalizer order and layer-scope behavior, measured (`probe6.mjs`):

```
before dispose:
use: 1
after dispose: acquire,finalizer,release
```

Meaning: `Layer.effect` builds lazily on first `runPromise`, and resources acquired inside it are released
when the `ManagedRuntime` is disposed. Finalizers run LIFO (`addFinalizer` before `acquireRelease`'s release).

What a Pi extension needs for session shutdown:

1. Build `const runtime = ManagedRuntime.make(AppLayer)` once at extension init.
2. Keep any per-event `Fiber` handles (or a `FiberSet`) so in-flight work can be interrupted.
3. On shutdown: `await runtime.dispose()`. That closes the runtime scope, so every `acquireRelease`
   and `addFinalizer` inside the layer runs. For per-event scopes, wrap the effect in `Effect.scoped`
   and the scope closes when the effect finishes or is interrupted.
4. Do not put persistence writes in `addFinalizer` if they can fail; the finalizer type requires
   `Effect<void, never>`, so log and swallow, or use `Effect.ensuring` on the event effect instead.

## 9. Testing

Checked: there is **no** `@effect/vitest` in `node_modules` (`ls node_modules/@effect/*` shows only
`platform-node` and `platform-node-shared`), and no `effect/Vitest` subpath. `npm view @effect/vitest version`
reports `4.1.1`, which does not match the installed beta.

What ships with the package:

```
effect/testing -> FastCheck, TestClock, TestConsole, TestSchema
```

There is no `effect/Test`, `effect/Vitest` or `effect/TestClock` module; all three fail to resolve
(`ERR_MODULE_NOT_FOUND`, mapped to `dist/Test.js`, `dist/Vitest.js`, `dist/TestClock.js`, none of which exist).
TestClock is reached only as `import { TestClock } from "effect/testing"`.

`TestClock` API verified from `dist/testing/TestClock.d.ts`:

```ts
export declare const make: (options?: TestClock.Options) => Effect.Effect<{...}>;
export declare const layer: (options?: TestClock.Options) => Layer.Layer<TestClock>;
export declare const testClockWith: <A, E, R>(f: (testClock: TestClock) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
export declare const adjust: (duration: Duration.Input) => Effect.Effect<void>;
export declare const setTime: (timestamp: number) => Effect.Effect<void>;
export declare const withLive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
```

Deterministic timeout test, measured with `Date.now()` around it:

```
testclock timeout result: None (timed out) | wall ms: 3
```

```ts
import { Duration, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

await Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(
    Effect.sleep(Duration.minutes(5)).pipe(Effect.timeoutOption(Duration.minutes(1))),
  )
  yield* TestClock.adjust(Duration.minutes(1))
  const result = yield* Fiber.join(fiber)
  assert.ok(Option.isNone(result))
}).pipe(Effect.provide(TestClock.layer())))
```

**Use plain `node:test`.** It runs effectful tests by awaiting `Effect.runPromise` / `runPromiseExit`, and the
repo already does this (`extensions/git-info/refresh-coordinator.test.ts`, `process.test.ts` use
`Deferred`, `Effect`, `Fiber` under `node --test --experimental-strip-types`). There is no reason to add
`@effect/vitest` while the effect version is a beta.

Test recipe used in the example file:

- `await Effect.runPromiseExit(program.pipe(Effect.provide(Live)))`, then assert `Exit.isSuccess(exit)`.
- For failure cases, assert `Exit.isFailure(exit)` and narrow via `Exit.findErrorOption(exit)`.
- For pure schema checks, call `Schema.decodeUnknownSync` / `assert.throws`.
- Add `TestClock.layer()` to the provided layers only when time is involved.

## 10. Concurrency

Verified signatures:

```ts
export declare const all: <const Arg extends Iterable<Effect<any, any, any>> | Record<string, Effect<any, any, any>>, O extends {
    readonly concurrency?: Concurrency | undefined;
    readonly discard?: boolean | undefined;
    readonly mode?: "default" | "result" | undefined;
}>(arg: Arg, options?: O) => All.Return<Arg, O>;

export declare const forEach: {
    <B, E, R, S extends Iterable<any>, const Discard extends boolean = false>(f: (a: ..., i: number) => Effect<B, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard?: Discard | undefined;
    }): (self: S) => Effect<...>;
    // plus data-first overload
};
export declare const validate: ...;   // errors are Arr.NonEmptyArray<E>

export declare const forkChild: <...>(effectOrOptions?: Arg, options?: {...}) => Effect<Fiber<A, E>, never, R>;
export declare const forkScoped: <...>(effectOrOptions?: Arg, options?: {...}) => Effect<Fiber<A, E>, never, R | Scope>;
export declare const forkDetach: <...>(effectOrOptions?: Arg, options?: {...}) => Effect<Fiber<A, E>, never, R>;
export declare const race: {
    <A2, E2, R2>(that: Effect<A2, E2, R2>, options?: { readonly onWinner?: ... }): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
    // plus data-first overload
};
export declare const timeout: {
    (duration: Duration.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | Cause.TimeoutError, R>;
    <A, E, R>(self: Effect<A, E, R>, duration: Duration.Input): Effect<A, E | Cause.TimeoutError, R>;
};
export declare const timeoutOption: ...;
export declare const forever: ...; export declare const sleep: (duration: Duration.Input) => Effect<void>;

export declare const make: <A, E = never>() => Effect<Deferred<A, E>>;                    // Deferred
export declare const make: <A, E = never>(options?: {                                     // Queue
    readonly capacity?: number | undefined;
    readonly strategy?: "suspend" | "dropping" | "sliding" | undefined;
} | undefined) => Effect<Queue<A, E>>;
export declare const unbounded: <A, E = never>() => Effect<Queue<A, E>>;                  // Queue
export declare const subscribe: <A>(self: PubSub<A>) => Effect.Effect<Subscription<A>, never, Scope.Scope>;  // PubSub
```

`Effect.fork`, `Effect.forkDaemon` and `Effect.daemon` do not exist. Use `forkChild` (attached to the parent
fiber's scope: when the parent terminates the child is terminated too), `forkScoped` (interrupted when the
enclosing `Scope` closes), or `forkDetach` (detached daemon: keeps running after the forking effect completes).

Measured: `forkScoped(Effect.forever(...))` inside `Effect.scoped` ticked 3 times during 35 ms and stopped
when the scope closed. `PubSub.subscribe` **requires a scope**; calling it outside `Effect.scoped` fails with
`Service not found: effect/Scope`.

Avoiding unbounded fiber leaks in a long-lived extension:

1. Never call `Effect.runFork` / `forkDetach` per event without keeping the `Fiber` handle. Keep one handle
   per session/event and `Fiber.interrupt` it on completion or shutdown.
2. Prefer `Effect.forkScoped` inside a per-event `Effect.scoped`, so interruption and cleanup are structural.
3. For collections of background tasks, `FiberSet.make()` (requires `Scope`) + `FiberSet.run(set, effect)`
   + `FiberSet.awaitEmpty(set)`; verified it joined 2 forked increments and returned `2`.
4. `Effect.forever` must always be paired with a scope or an explicit interrupt; otherwise it runs until the
   process exits.
5. Bound queues (`Queue.bounded(n)`, `PubSub.bounded(n)`) instead of `unbounded` for event streams coming
   from Pi callbacks, so a slow consumer cannot grow memory without limit.

## 11. Gotchas: Effect 4 beta.98 vs Effect 3

Every row was verified by `typeof` on the installed runtime export and/or the installed `.d.ts`.

| Effect 3 | Effect 4.0.0-beta.98 | Verified |
| --- | --- | --- |
| `Context.Tag`, `Context.GenericTag` | `Context.Service` (function or class style) | removed / present |
| `Effect.Service` | removed; use `Context.Service` + `Layer.effect` | removed |
| `Layer.scoped` | removed; `Layer.effect` runs scoped effects and strips `Scope` | removed / present |
| `Effect.catchAll` | `Effect.catch` | removed / present |
| `Effect.catchAllCause` | `Effect.catchCause` | removed / present |
| `Effect.catchSome` | `Effect.catchFilter` / `Effect.catchIf` | removed / present |
| `Effect.fork` | `Effect.forkChild` | removed / present |
| `Effect.forkDaemon`, `Effect.daemon` | `Effect.forkDetach` | removed / present |
| `Effect.zipRight`, `Effect.zipLeft` | `Effect.andThen` (value-discarding sequencing) | removed / present |
| `Effect.gen(this, function* () {})` | `Effect.gen({ self: this }, function* (this: Self) {})` | `TS2554` on the old form, old form removed |
| `Effect.timeoutFail` | `Effect.timeout` now fails with `Cause.TimeoutError`; `timeoutOption` for `None` | removed |
| `Effect.runSync` on async effect | throws `AsyncFiberError` (not `AsyncFiberException`) | measured |
| `Ref.unsafeMake`, `Semaphore.unsafeMake` | `Ref.makeUnsafe`, `Semaphore.makeUnsafe`, `SynchronizedRef.makeUnsafe` | removed / present |
| `Schema.TaggedError` | `Schema.TaggedErrorClass` (becomes `Schema.TaggedError` again in 4.1.1) | removed / present |
| `Schema.decodeUnknownEither` / `encodeEither` | `Schema.decodeUnknownResult` / `decodeUnknownExit` | removed / present |
| `Schema.filter`, `Schema.transform`, `Schema.transformOrFail` | `Schema.check`, `Schema.makeFilter`, `Schema.decodeTo` | removed / present |
| `Schema.optionalWith`, `propertySignature`, `extend`, `intersect`, `pick`, `omit` | removed; declare explicit `Struct` fields | removed |
| `Schema.UUID`, `Schema.Base64` | removed; use checks such as `Schema.isUUID()` / `Schema.isPattern` | removed / present |
| `Cause.failures`, `Cause.defects`, `Cause.isEmpty`, `Cause.isFailure`, `Cause.isDie` | `Cause.findErrorOption`, `Cause.findDefect`, `Cause.hasFails`, `Cause.hasDies` | removed / present |
| `Effect.promise(() => ...)` | `Effect.promise((signal) => ...)`; the thunk receives an `AbortSignal` | signature changed |
| `Effect.all`/`forEach` `concurrency` | unchanged (`Concurrency` option; `"unbounded"`, number, `"inherit"`) | measured |
| `Effect.validate` | present, but failures are `Arr.NonEmptyArray<E>` | verified |
| `@effect/vitest` | not shipped/installed for this version; `effect/testing` ships `TestClock`, `TestConsole`, `TestSchema`, `FastCheck` | `ls node_modules/@effect` |

Non-gotchas worth stating: `Effect.Effect<A, E, R>` is still three parameters, `Layer.Layer<ROut, E, RIn>`
is still three, `Layer.mergeAll`, `Layer.provide`, `Effect.provide`, `Effect.scoped`, `Scope`,
`ManagedRuntime`, `Deferred`, `Queue`, `PubSub`, `Semaphore`, `SynchronizedRef` all exist with familiar
names and shapes.

## 12. Complete example (typechecked and executed)

File: `/tmp/effect-probe/example.ts`. Scratch project: `/tmp/effect-probe/package.json` = `{"type":"module"}`,
`node_modules` symlinked to `/home/nacho/.pi/agent/node_modules`, `tsconfig.json` mirroring the repo
(`module`/`moduleResolution` `NodeNext`, `strict`, `skipLibCheck`, `verbatimModuleSyntax`, `target ES2022`,
`allowImportingTsExtensions`, `types: ["node"]`).

```ts
/**
 * Effect 4.0.0-beta.98 reference example: Schema-validated state service.
 *
 * Typecheck:
 *   tsc --noEmit -p /tmp/effect-probe/tsconfig.json
 * Run tests:
 *   node --test --experimental-strip-types example.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { Context, Effect, Exit, Layer, ManagedRuntime, Option, Ref, Schema, Semaphore, SynchronizedRef } from "effect"

// 1. Versioned snapshot schema. Decoded type is inferred, not hand-written.
const SnapshotV1 = Schema.Struct({
  version: Schema.Literals([1]),
  count: Schema.Int,
  updatedAt: Schema.DateFromString,
})

const SnapshotV2 = Schema.Struct({
  version: Schema.Literals([2]),
  count: Schema.Int,
  note: Schema.optional(Schema.String),
  updatedAt: Schema.DateFromString,
})

export const Snapshot = Schema.Union([SnapshotV1, SnapshotV2])
export type Snapshot = typeof Snapshot.Type

// JSON text <-> Snapshot, for persistence.
export const SnapshotJson = Schema.fromJsonString(Snapshot)

// 2. Typed errors: yieldable classes with a `_tag` and a Schema.
export class SnapshotDecodeError extends Schema.TaggedErrorClass<SnapshotDecodeError>()(
  "SnapshotDecodeError",
  { message: Schema.String, input: Schema.Unknown },
) {}

export class NegativeCountError extends Schema.TaggedErrorClass<NegativeCountError>()(
  "NegativeCountError",
  { message: Schema.String },
) {}

// 3. Service interface + class-style tag (Context.Service replaces Context.Tag).
export interface CounterShape {
  readonly increment: (by: number) => Effect.Effect<number, NegativeCountError>
  readonly read: Effect.Effect<Snapshot>
  readonly restore: (input: unknown) => Effect.Effect<Snapshot, SnapshotDecodeError>
}

export class Counter extends Context.Service<Counter, CounterShape>()("Counter") {}

// Validation of unknown JSON into a typed value, with a narrow error channel.
export const decodeSnapshot = (input: unknown): Effect.Effect<Snapshot, SnapshotDecodeError> =>
  Schema.decodeUnknownEffect(Snapshot)(input).pipe(
    Effect.mapError((error) => new SnapshotDecodeError({ message: error.message, input })),
  )

// 4. Layer implementation backed by a SynchronizedRef.
export const CounterLive = Layer.effect(
  Counter,
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<Snapshot>({
      version: 1,
      count: 0,
      updatedAt: new Date(0),
    })

    // Serializes multi-step sections (decode + write) that touch the ref twice.
    const gate = Semaphore.makeUnsafe(1)

    const shape: CounterShape = {
      increment: (by) =>
        SynchronizedRef.modifyEffect(state, (current) => {
          const next = current.count + by
          if (next < 0) {
            return Effect.fail(new NegativeCountError({ message: "count would go negative" }))
          }
          return Effect.succeed([next, { ...current, count: next, updatedAt: new Date() }] as const)
        }),
      read: Ref.get(state),
      restore: (input) =>
        gate.withPermit(
          Effect.gen(function* () {
            const next = yield* decodeSnapshot(input)
            yield* SynchronizedRef.set(state, next)
            return next
          }),
        ),
    }

    return shape
  }),
)

// 5. Program + host-code entry points.
export const program = Effect.gen(function* () {
  const counter = yield* Counter
  const restored = yield* counter.restore({
    version: 2,
    count: 5,
    note: "from disk",
    updatedAt: "2024-01-01T00:00:00.000Z",
  })
  const next = yield* counter.increment(2)
  return { restored, next }
})

export const main = program.pipe(Effect.provide(CounterLive))

// A ManagedRuntime builds the layer once; per-event work reuses it.
export const makeCounterRuntime = () => ManagedRuntime.make(CounterLive)

export const runIncrement = async (runtime: ReturnType<typeof makeCounterRuntime>, by: number) => {
  const exit = await runtime.runPromiseExit(
    Effect.gen(function* () {
      const counter = yield* Counter
      return yield* counter.increment(by)
    }),
  )
  return Exit.isSuccess(exit) ? exit.value : undefined
}

// 6. Tests: plain node:test, no @effect/vitest needed.
test("decode accepts v1 and v2, rejects unknown versions", () => {
  const v1 = Schema.decodeUnknownSync(Snapshot)({ version: 1, count: 3, updatedAt: "2024-01-01T00:00:00.000Z" })
  assert.equal(v1.version, 1)
  assert.ok(v1.updatedAt instanceof Date)
  assert.throws(() => Schema.decodeUnknownSync(Snapshot)({ version: 3, count: 3 }))
})

test("service runs under a layer", async () => {
  const exit = await Effect.runPromiseExit(main)
  assert.ok(Exit.isSuccess(exit))
  assert.equal(exit.value.next, 7)
})

test("typed failure survives with its tag", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const counter = yield* Counter
      return yield* counter.increment(-1)
    }).pipe(Effect.provide(CounterLive)),
  )
  assert.ok(Exit.isFailure(exit))
  const error = Exit.findErrorOption(exit)
  assert.ok(Option.isSome(error))
  assert.ok(error.value instanceof NegativeCountError)
  assert.equal(error.value._tag, "NegativeCountError")
})

test("invalid snapshot is reported as SnapshotDecodeError", async () => {
  const result = await Effect.runPromise(
    Effect.flip(decodeSnapshot({ version: 9 })),
  )
  assert.equal(result._tag, "SnapshotDecodeError")
})

test("JSON round trip", () => {
  const encoded = Schema.encodeSync(SnapshotJson)({
    version: 1,
    count: 2,
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  })
  assert.equal(typeof encoded, "string")
  assert.equal(Schema.decodeUnknownSync(SnapshotJson)(encoded).count, 2)
})
```

### Exact verification commands and output

There is no `tsc` in the project: `/home/nacho/.pi/agent/node_modules/.bin/tsc` does not exist and
`npm run check` fails with `tsc: command not found` (`typescript` is declared but not installed). The
TypeScript 7.0.2 compiler was taken from the local npx cache instead, which matches the repo's
`typescript: ^7.0.2` devDependency claim:

```
$ node /home/nacho/.npm/_npx/d08dbff2f92d3e31/node_modules/typescript/bin/tsc --version
Version 7.0.2

$ cd /tmp/effect-probe && node /home/nacho/.npm/_npx/d08dbff2f92d3e31/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
TSC_EXIT=0
```

(`tsconfig.json` includes `probe.ts`, `example.ts`, `probe.test.ts`; `probe.ts` is a second variant using
`Context.Service` + `Semaphore` + plain object shape, also clean.)

Tests:

```
$ cd /tmp/effect-probe && node --test --experimental-strip-types example.ts
✔ decode accepts v1 and v2, rejects unknown versions (2.540266ms)
✔ service runs under a layer (1.328625ms)
✔ typed failure survives with its tag (0.448258ms)
✔ invalid snapshot is reported as SnapshotDecodeError (0.535383ms)
✔ JSON round trip (0.544702ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

Runtime probes that back the claims in this document (all in `/tmp/effect-probe`):

| Probe | Confirms |
| --- | --- |
| `probe0.mjs` | `Schema` name presence, `DateFromString` decodes to `Date`, `SchemaError` message text |
| `probe2.mjs` | Semaphore serialization, `Effect.all` concurrency, ManagedRuntime, scope/finalizer order, `forkScoped` interruption, `timeoutOption`, Queue, Layer.mergeAll |
| `probe3.mjs` | PubSub needs a scope, `Deferred`, `catchTag`, `Cause.pretty`/`squash`, `Effect.fn`/`fnUntraced`, `Fiber.join` |
| `probe4.mjs` | `runSync` behavior for sync success, typed failure, defect, async effect |
| `probe5.mjs` | `TestClock` deterministic timeout (3 ms wall), `FiberSet` join |
| `probe6.mjs` | layer-scope acquisition/release on `ManagedRuntime.dispose`, `runPromise` rejection modes |
| `probe7.ts` | generator/fn compile matrix under TS 7.0.2 ESM |

## 13. Repo reference implementations to copy from

| Concern | File |
| --- | --- |
| `ManagedRuntime` + layer + `runPromiseExit` wrapper for host code | `extensions/git-info/src/runtime.ts` |
| `Semaphore.makeUnsafe(1)` + `withPermit` / `withPermitsIfAvailable` | `extensions/git-info/src/refresh-coordinator.ts` |
| `Context.Tag` replacement in practice (`Context.Service` + `Layer.effect`), `Stream` | `extensions/git-info/src/process.ts` |
| `Deferred` / `Fiber` / `Effect` in `node:test` | `extensions/git-info/refresh-coordinator.test.ts` |
| Domain errors with `Data.TaggedError` (non-Schema errors) | `extensions/background-terminals/src/domain.ts` |
| `Layer` + `ManagedRuntime` in a long-lived extension | `extensions/background-terminals/src/runtime.ts` |

`extensions/subagents/src` does not import `effect` (its `grep` hits are the English word "effects"),
so `git-info` and `background-terminals` are the reference implementations for this version.
