# Getting Started with TIO

This guide will help you get up and running with TIO quickly.

## Installation

TIO is not published on npm yet. For now, clone the repository and build it:

```bash
git clone https://github.com/brkaisin/tio.git
cd tio
npm install
npx tsc
```

## Basic Concepts

TIO is a functional effect system. An "effect" is a description of a computation that may:
- Succeed with a value of type `A`
- Fail with an error of type `E`
- Require an environment of type `R`

This is captured in the type `TIO<R, E, A>`.

## Your First Effect

```typescript
import { TIO } from "tio/tio";
import { Runtime } from "tio/runtime";

// Create an effect that succeeds with 42
const myEffect = TIO.succeed(42);

// Run the effect
const result = await Runtime.default.unsafeRun(myEffect);
console.log(result); // 42
```

## Creating Effects

### From Values

```typescript
// Success
const success = TIO.succeed(42);

// Failure
const failure = TIO.fail("something went wrong");
```

### From Promises

```typescript
const fromPromise = TIO.fromPromise(
    () => fetch("/api/data").then(r => r.json()),
    (error) => `Fetch failed: ${error}` // Error mapper
);
```

### From Synchronous Code

```typescript
const sync = TIO.make(() => {
    console.log("Hello!");
    return 42;
});
```

### From Async Callbacks

```typescript
const async = TIO.async<unknown, Error, string>((_, resolve, reject) => {
    setTimeout(() => resolve("done"), 1000);
});
```

## Transforming Effects

### Map (transform success value)

```typescript
const doubled = TIO.succeed(21).map(x => x * 2);
// Result: 42
```

### FlatMap (chain effects)

```typescript
const chained = TIO.succeed(21)
    .flatMap(x => TIO.succeed(x * 2));
// Result: 42
```

### MapError (transform error value)

```typescript
const mapped = TIO.fail("error")
    .mapError(e => new Error(e));
// Error: Error("error")
```

## Generators (async/await style)

Chaining many `flatMap`s quickly becomes nested, especially when a later step needs a value from an earlier one.
`TIO.gen` lets you write the same thing sequentially: inside the generator, `yield*` runs an effect and
evaluates to its success value, just like `await` does for a Promise.

```typescript
const summary = (input: string) =>
    TIO.gen(function* () {
        const id = yield* parseId(input);        // TIO<void, "invalid id", number>
        const user = yield* fetchUser(id);       // TIO<void, "user not found", User>
        const orders = yield* fetchOrders(user); // TIO<void, "network error", Order[]>

        if (orders.length === 0) {
            return yield* TIO.fail("no orders" as const);
        }
        return `${user.name}: ${orders.length} orders`;
    });
// TIO<void, "invalid id" | "user not found" | "network error" | "no orders", string>
```

- The first failure short-circuits the rest of the block.
- The error type is the union of the errors of all the yielded effects, and the environment is the
  intersection of their environments: nothing to annotate.
- The block is lazy like any other effect: the generator starts each time the effect runs, so it can be
  run, retried or raced any number of times.
- Typed failures are not thrown, so `try/catch` inside the generator won't catch them: use combinators on the
  yielded effect instead, e.g. `yield* fetchUser(id).orElse(TIO.succeed(guest))`.

## Handling Errors

### OrElse (fallback on error)

```typescript
const withFallback = TIO.fail("error")
    .orElse(TIO.succeed("fallback"));
// Result: "fallback"
```

### FoldM (handle both cases)

```typescript
const handled = TIO.fail("error")
    .foldM(
        (error) => TIO.succeed(`Recovered from: ${error}`),
        (value) => TIO.succeed(`Got: ${value}`)
    );
```

### Retry

```typescript
const retried = unstableEffect.retry(3); // Retry up to 3 times
```

## Running Effects

The `Runtime` is responsible for executing effects:

```typescript
const runtime = Runtime.default;

// Throws on error
const value = await runtime.unsafeRun(effect);

// Returns Either<E, A>
const either = await runtime.safeRunEither(effect);

// Returns Exit<E, A>
const exit = await runtime.safeRunExit(effect);

// Returns E | A (union)
const union = await runtime.safeRunUnion(effect);
```

## Next Steps

- [Core Concepts](./core-concepts.md) - Deep dive into TIO's design
- [Fibers](./fibers.md) - Concurrent execution with fibers
- [Error Handling](./error-handling.md) - Advanced error handling with Cause
- [Dependency Injection](./dependency-injection.md) - Managing dependencies with the environment

