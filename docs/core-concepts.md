# Core Concepts

This document explains the fundamental concepts behind TIO.

## What is a Functional Effect?

An effect is a **description** of a computation, not the computation itself. Think of it like a recipe: the recipe describes how to make a cake, but it's not the cake itself. You need to "run" the recipe (follow the instructions) to get the actual cake.

```typescript
// This doesn't print anything - it's just a description
const effect = TIO.make(() => console.log("Hello!"));

// This actually prints "Hello!"
await Runtime.default.unsafeRun(effect);
```

## Why Effects?

### 1. Referential Transparency

In pure functional programming, expressions should be replaceable by their values. Promises break this:

```typescript
// These are NOT equivalent!
const p1 = Promise.resolve(Math.random());
const p2 = Promise.resolve(Math.random());

// p1 and p2 have different values because Math.random() runs immediately
```

With TIO:

```typescript
// These ARE equivalent!
const e1 = TIO.make(() => Math.random());
const e2 = TIO.make(() => Math.random());

// Both describe "get a random number" - the actual value is computed when run
```

### 2. Typed Errors

Promises have untyped errors (`Promise<T>` doesn't tell you what errors can occur). TIO has a dedicated error channel:

```typescript
// The type tells you this can fail with a string
const effect = TIO.fail("oops"); // IO<string, never>
```

### 3. Laziness

Promises are eager - they start executing immediately. TIO is lazy:

```typescript
// This HTTP request happens RIGHT NOW
const promise = fetch("/api/data");

// This is just a description - no request yet
const effect = TIO.fromPromise(() => fetch("/api/data"));

// Request happens when you run it
await runtime.unsafeRun(effect);
```

### 4. Composability

Effects compose naturally:

```typescript
const program = getUser(userId)
    .flatMap(user => getOrders(user.id))
    .flatMap(orders => sendEmail(orders))
    .retry(3)
    .timeout(5000)
    .tap(result => log(`Success: ${result}`))
    .tapError(error => log(`Failed: ${error}`));
```

## The TIO Type

```typescript
TIO<R, E, A>
```

| Parameter | Meaning |
|-----------|---------|
| `R` | **Environment** - Dependencies needed to run |
| `E` | **Error** - Type of errors that can occur |
| `A` | **Success** - Type of the success value |

### Common Type Aliases

```typescript
type IO<E, A> = TIO<any, E, A>;      // No environment needed
type UIO<A> = TIO<any, never, A>;    // Cannot fail
type URIO<R, A> = TIO<R, never, A>;  // Needs environment, cannot fail
type Task<A> = TIO<any, Error, A>;   // Fails with Error
```

## The Runtime

The `Runtime` is the interpreter that executes effects. It:

1. Traverses the effect tree
2. Executes each operation
3. Handles errors and successes
4. Provides the environment

```typescript
// Default runtime with no environment
const runtime = Runtime.default;

// Runtime with custom services
const customRuntime = Runtime.default
    .provideService(LoggerTag, myLogger)
    .provideService(DatabaseTag, myDatabase);
```

## Execution Methods

| Method | Return Type | Error Handling |
|--------|-------------|----------------|
| `unsafeRun` | `Promise<A>` | Throws on error |
| `safeRunEither` | `Promise<Either<E, A>>` | Returns Left/Right |
| `safeRunExit` | `Promise<Exit<E, A>>` | Returns success/failure |
| `safeRunUnion` | `Promise<E \| A>` | Returns error or value |

## Effect Operations

### Creation

| Operation | Description |
|-----------|-------------|
| `TIO.succeed(a)` | Effect that succeeds with `a` |
| `TIO.fail(e)` | Effect that fails with `e` |
| `TIO.make(f)` | Effect from sync function |
| `TIO.async(register)` | Effect from async callback |
| `TIO.fromPromise(f)` | Effect from Promise |
| `TIO.fromEither(either)` | Effect from Either |
| `TIO.sleep(ms)` | Effect that waits |

### Transformation

| Operation | Description |
|-----------|-------------|
| `.map(f)` | Transform success value |
| `.mapError(f)` | Transform error value |
| `.flatMap(f)` | Chain with another effect |
| `TIO.flatten(effect)` | Flatten nested effect |
| `.as(b)` | Replace success value |
| `.unit()` | Discard success value |

### Error Handling

| Operation | Description |
|-----------|-------------|
| `.orElse(that)` | Fallback on error |
| `.foldM(onErr, onSucc)` | Handle both cases with effects |
| `.fold(onErr, onSucc)` | Handle both cases with functions |
| `.retry(n)` | Retry on failure |
| `.absolve()` | Convert `TIO<R, E, Either<E1, A>>` to `TIO<R, E \| E1, A>` |

### Side Effects

| Operation | Description |
|-----------|-------------|
| `.tap(f)` | Run effect on success, keep original value |
| `.tapError(f)` | Run effect on error, keep original error |
| `.tapBoth(f, g)` | Run effect on both cases |
| `.ensuring(fin)` | Always run finalizer |

### Combinators

| Operation | Description |
|-----------|-------------|
| `.zip(that)` | Combine two effects into tuple |
| `.zipLeft(that)` | Run both, keep left result |
| `.zipRight(that)` | Run both, keep right result |
| `TIO.all(...effects)` | Run all in parallel |
| `TIO.race(...effects)` | Return first to complete |

### Timing

| Operation | Description |
|-----------|-------------|
| `.delay(ms)` | Delay execution |
| `.timeout(ms)` | Fail if not complete in time |
| `TIO.sleep(ms)` | Wait for duration |

## Next Steps

- [Fibers](./fibers.md) - Concurrent execution
- [Error Handling](./error-handling.md) - Rich error types with Cause
- [Dependency Injection](./dependency-injection.md) - Managing the environment

