# Error Handling with Cause

TIO provides a rich error model through the `Cause` type, which captures the complete story of why an effect failed.

## The Problem with Simple Errors

Consider this scenario:

```typescript
const effect = someOperation()
    .ensuring(cleanup());
```

What if both `someOperation()` and `cleanup()` fail? With simple error types (like `Promise`), you'd lose one of them. You might see only the cleanup error, or only the original error, depending on implementation.

## What is Cause?

`Cause<E>` is a data structure that captures **all** failure information, including:

| Cause Type | Description |
|------------|-------------|
| `Empty` | No error (identity for combining) |
| `Fail<E>` | A typed, expected error of type `E` |
| `Die` | An unexpected defect (untyped, like thrown exceptions) |
| `Interrupt` | The fiber was interrupted/cancelled |
| `Then` | Sequential composition: first failed, then finalizer also failed |
| `Both` | Parallel composition: both branches failed |

## Cause Hierarchy

```
Cause<E>
├── Empty           — No error
├── Fail<E>         — Expected, typed error
├── Die             — Unexpected defect (thrown exception)
├── Interrupt       — Fiber was cancelled
├── Then<E>         — Sequential: left happened, then right
└── Both<E>         — Parallel: left and right happened together
```

## Expected vs Unexpected Errors

TIO distinguishes between two kinds of failures:

### Fail: Expected Errors

These are errors you anticipate and handle. They are typed and appear in the `E` parameter:

```typescript
const divide = (a: number, b: number): TIO<never, "division by zero", number> =>
    b === 0 ? TIO.fail("division by zero") : TIO.succeed(a / b);
```

### Die: Unexpected Defects

These are unexpected errors—bugs, programming errors, or truly exceptional conditions:

```typescript
const parseJson = (s: string): TIO<never, never, object> =>
    TIO.make(() => JSON.parse(s)); // Throws if invalid JSON

// If JSON.parse throws, it becomes a Die (defect)
```

Any exception thrown by your code (in `TIO.make`, in the function passed to `map`/`flatMap`, ...) becomes a `Die`.
Defects are not part of the error type `E`, so they are **not** caught by `foldM`, `orElse`, `mapError`, etc.
To turn an exception into a typed error, catch it yourself and use `TIO.fail`, or use `TIO.fromPromise`.

## Cause in FiberExit

When a fiber completes with a failure, the `FiberExit` contains a `Cause`:

```typescript
type FiberSuccess<A> = { readonly _tag: FiberTag.Success; readonly value: A };
type FiberFailure<E> = { readonly _tag: FiberTag.Failure; readonly cause: Cause<E> };

export type FiberExit<E, A> = FiberSuccess<A> | FiberFailure<E>;
```

Example:

```typescript
import { isFiberFailure } from "tio/fiber";

const fiberExit = await runtime.unsafeRun(
    TIO.fail("oops").fork().flatMap((f) => TIO.awaitFiber(f))
);

if (isFiberFailure(fiberExit)) {
    console.log(fiberExit.cause);
    // { _tag: "Fail", error: "oops" }
}
```

## Composite Causes

### Then: Sequential Failures

When an effect fails and its finalizer also fails:

```typescript
const effect = TIO.fail("primary error")
    .ensuring(TIO.make(() => { throw new Error("cleanup failed"); }));
```

The cause would be:

```
Then(
  Fail("primary error"),
  Die(Error("cleanup failed"))
)
```

### Both: Parallel Failures

`Both` combines failures that happened concurrently, in different fibers. Note that `TIO.all` fails fast:
as soon as one effect fails, the others are interrupted, so usually only the first failure is reported.

```typescript
const effect = TIO.all(
    TIO.fail("error1").delay(10),
    TIO.fail("error2").delay(20) // interrupted before it can fail
);
// Fail("error1")
```

If several effects fail before being interrupted (for instance an interrupted effect whose finalizer dies),
the causes are combined with `Both`.

## Working with Causes

### Creating Causes

```typescript
import { 
    empty, 
    fail, 
    die, 
    interrupt, 
    sequential, 
    both 
} from "tio/cause";

const noCause = empty;
const failCause = fail("something went wrong");
const dieCause = die(new Error("unexpected"));
const interruptCause = interrupt({ id: 1, startTime: Date.now() });
const sequentialCause = sequential(fail("first"), fail("second"));
const parallelCause = both(fail("left"), fail("right"));
```

### Inspecting Causes

```typescript
import { 
    failures,      // Extract all Fail errors
    defects,       // Extract all Die defects
    interruptors,  // Extract all interrupt FiberIds
    isEmpty,       // Check if empty
    isFailure,     // Check if contains failures
    isInterrupted, // Check if interrupted
    isDie,         // Check if contains defects
    prettyPrint    // Human-readable representation
} from "tio/cause";

const cause = both(
    fail("error1"),
    sequential(fail("error2"), die(new Error("oops")))
);

failures(cause);     // ["error1", "error2"]
defects(cause);      // [Error("oops")]
isFailure(cause);    // true
isDie(cause);        // true
prettyPrint(cause);  // "Both(Fail(error1), Then(Fail(error2), Die(Error: oops)))"
```

### Transforming Causes

```typescript
import { map } from "tio/cause";

const cause = fail("error");
const mapped = map(cause, (e) => e.toUpperCase());
// Fail("ERROR")
```

### Squashing Causes

Get the "most important" error (priority: Failures > Defects > Interrupts):

```typescript
import { squash } from "tio/cause";

const cause = both(
    interrupt({ id: 1, startTime: 0 }),
    fail("error")
);

squash(cause); // "error" (failures take priority)
```

## Handling Causes in Practice

### Pattern 0: Handle the Cause inside an Effect

`foldCauseM` is like `foldM`, but gives access to the full `Cause` (including defects and interruptions),
and `TIO.failCause` fails with a given `Cause`:

```typescript
const safe = riskyOperation.foldCauseM(
    (cause) =>
        isDie(cause)
            ? TIO.succeed("fallback after a defect")
            : TIO.failCause(cause), // propagate failures and interruptions untouched
    (value) => TIO.succeed(value)
);
```

Note that an interrupted fiber cannot recover from its interruption: in an interruptible region, it keeps
being interrupted whatever the handler returns (finalizers still run).

### Pattern 1: Inspect Exit Value

```typescript
import { isFiberFailure } from "tio/fiber";

const fiberExit = await runtime.unsafeRun(
    effect.fork().flatMap((f) => TIO.awaitFiber(f))
);

if (isFiberFailure(fiberExit)) {
    const cause = fiberExit.cause;

    if (isInterrupted(cause)) {
        console.log("Operation was cancelled");
    } else if (isDie(cause)) {
        console.error("Bug detected:", defects(cause));
    } else {
        console.log("Expected error:", failures(cause));
    }
}
```

### Pattern 2: Log All Errors

```typescript
function logAllErrors<E>(cause: Cause<E>): void {
    for (const error of failures(cause)) {
        console.error("Expected error:", error);
    }
    for (const defect of defects(cause)) {
        console.error("Unexpected defect:", defect);
    }
    for (const fiberId of interruptors(cause)) {
        console.warn("Interrupted by fiber:", fiberId.id);
    }
}
```

### Pattern 3: Convert Cause to Error Message

```typescript
function causeToMessage<E>(cause: Cause<E>): string {
    const errors = failures(cause);
    const defs = defects(cause);
    
    if (errors.length > 0) {
        return `Failed with: ${errors.join(", ")}`;
    }
    if (defs.length > 0) {
        return `Unexpected error: ${defs.map(String).join(", ")}`;
    }
    if (isInterrupted(cause)) {
        return "Operation was cancelled";
    }
    return "Unknown error";
}
```

## Complete Example

```typescript
import { TIO } from "tio/tio";
import { Runtime } from "tio/runtime";
import { failures, defects, isInterrupted, prettyPrint } from "tio/cause";
import { isFiberSuccess } from "tio/fiber";

const runtime = Runtime.default;

// An operation that might fail in various ways
const riskyOperation = TIO.make(() => {
    const rand = Math.random();
    if (rand < 0.3) throw new Error("Unexpected crash!");
    return rand < 0.6 ? "success" : "failure";
}).flatMap((result) =>
    result === "success" 
        ? TIO.succeed(result)
        : TIO.fail("Operation failed")
);

// Run with cleanup
const program = riskyOperation
    .ensuring(
        TIO.make(() => {
            console.log("Cleaning up...");
            // Cleanup might also fail!
            if (Math.random() < 0.2) throw new Error("Cleanup failed!");
        })
    )
    .fork()
    .flatMap((fiber) => TIO.awaitFiber(fiber));

runtime.unsafeRun(program).then((exit) => {
    if (isFiberSuccess(exit)) {
        console.log("Result:", exit.value);
    } else {
        console.log("Failure cause:", prettyPrint(exit.cause));
        console.log("Expected errors:", failures(exit.cause));
        console.log("Unexpected defects:", defects(exit.cause));
        console.log("Was interrupted:", isInterrupted(exit.cause));
    }
});
```

## Summary

| Function | Description |
|----------|-------------|
| `fail(e)` | Create a Fail cause |
| `die(defect)` | Create a Die cause |
| `interrupt(fiberId)` | Create an Interrupt cause |
| `sequential(left, right)` | Combine sequentially |
| `both(left, right)` | Combine in parallel |
| `failures(cause)` | Extract all typed errors |
| `defects(cause)` | Extract all defects |
| `interruptors(cause)` | Extract all interruptors |
| `isFailure(cause)` | Check for failures |
| `isDie(cause)` | Check for defects |
| `isInterrupted(cause)` | Check for interruption |
| `isInterruptedOnly(cause)` | Check for interruption only (no failures nor defects) |
| `prettyPrint(cause)` | Human-readable string |
| `squash(cause)` | Get most important error |

## Next Steps

- [Fibers](./fibers.md) - Concurrent execution and interruption
- [Core Concepts](./core-concepts.md) - TIO fundamentals

