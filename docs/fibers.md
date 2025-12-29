# Fibers: Scalable Concurrency

Fibers are TIO's mechanism for concurrent execution. This guide explains what fibers are, how they work, and how to use them effectively.

## What are Fibers?

Fibers are **lightweight virtual threads** that enable concurrent execution of effects. Unlike OS threads, fibers are:

- **Cheap to create**: You can spawn thousands of fibers without significant overhead
- **Cooperatively scheduled**: Fibers yield control at async boundaries (like `await` points)
- **Interruptible**: A fiber can be cancelled from the outside

## Concurrency vs Parallelism

> ⚠️ **Important distinction**: Fibers provide **concurrency**, not **parallelism**.

| Concept | Definition | Example |
|---------|------------|---------|
| **Concurrency** | Dealing with multiple things at once (interleaved execution) | A single chef preparing multiple dishes by switching between them |
| **Parallelism** | Doing multiple things at once (simultaneous execution) | Multiple chefs each preparing a dish at the same time |

JavaScript is single-threaded, so TIO fibers run **concurrently** on the event loop, not in parallel. However, I/O operations (network requests, timers, file system) can proceed in parallel while your fiber awaits them.

```
JavaScript Thread
─────────────────────────────────────────────────►
     │                │                │
     ▼                ▼                ▼
  Fiber A          Fiber B          Fiber A
  (runs)           (runs)           (runs)
     │                │                │
     └── await ───────┘                │
         (yields)                      │
                                       │
                    I/O operations run in parallel
                    ════════════════════════════►
```

## How Fibers Work

When you call `.fork()` on an effect, TIO:

1. Creates a new `FiberContext` to track the fiber's state
2. Schedules the effect to run asynchronously via `queueMicrotask()`
3. Returns immediately with a `Fiber` handle

The forked effect runs independently. You can:
- **Join** it: wait for its result
- **Await** it: wait for its exit value (success or failure)
- **Interrupt** it: cancel its execution

```
Main Fiber                    Forked Fiber
    │                              
    ├─── fork() ──────────────────►│
    │                              │
    │   (continues immediately)    │ (runs independently)
    │                              │
    ├─── join() ───────────────────┤
    │   (waits for result)         │
    │                              ▼
    │◄─────────────────────────────┤ (completes)
    │                              
    ▼
```

## Basic Fork and Join

```typescript
import { TIO } from "tio/tio";
import { Runtime } from "tio/runtime";

const runtime = Runtime.default;

// Fork an effect to run concurrently
const program = TIO.succeed(42)
    .delay(100)                                 // Simulate async work
    .fork()                                     // Fork into a new fiber
    .flatMap((fiber) => TIO.joinFiber(fiber));  // Wait for the result

const result = await runtime.unsafeRun(program); // 42
```

## Running Effects Concurrently

Fibers shine when you need to run multiple independent operations concurrently:

```typescript
const fetchUser = TIO.fromPromise(() => fetch("/api/user")).delay(100);
const fetchPosts = TIO.fromPromise(() => fetch("/api/posts")).delay(150);
const fetchComments = TIO.fromPromise(() => fetch("/api/comments")).delay(80);

// Sequential execution: ~330ms total
const sequential = fetchUser
    .flatMap(() => fetchPosts)
    .flatMap(() => fetchComments);

// Concurrent execution: ~150ms total (limited by slowest)
const concurrent = TIO.forkAll([fetchUser, fetchPosts, fetchComments])
    .flatMap((fibers) => 
        TIO.all(...fibers.map((f) => TIO.joinFiber(f)))
    );
```

### Visual Comparison

```
Sequential:
├── fetchUser (100ms) ──►├── fetchPosts (150ms) ──►├── fetchComments (80ms) ──►│
                                                                        Total: 330ms

Concurrent:
├── fetchUser (100ms) ────────►│
├── fetchPosts (150ms) ────────────────►│
├── fetchComments (80ms) ──►│           │
                                  Total: 150ms
```

## Fiber States

A fiber can be in one of three states:

| State | Description |
|-------|-------------|
| `Running` | The fiber is currently executing |
| `Suspended` | The fiber is waiting (e.g., for I/O or a timer) |
| `Done` | The fiber has completed with a `FiberExit` |

You can check a fiber's status:

```typescript
const status = await runtime.unsafeRun(TIO.fiberStatus(fiber));
// { _tag: "Running" } or { _tag: "Suspended" } or { _tag: "Done", exit: ... }
```

## FiberExit

A `FiberExit<E, A>` represents how a fiber completed:

```typescript
type FiberExit<E, A> =
    | { _tag: "Success"; value: A }        // Completed successfully
    | { _tag: "Failure"; cause: Cause<E> } // Failed with a Cause
```

The `Cause` in a failure provides rich information about what went wrong. See [Error Handling](./error-handling.md) for details.

## Awaiting vs Joining

| Method | Behavior |
|--------|----------|
| `TIO.joinFiber(fiber)` | Waits for the fiber and **propagates** its result. If the fiber failed, the failure is re-thrown. |
| `TIO.awaitFiber(fiber)` | Waits for the fiber and **returns** its `FiberExit`. Failures are not propagated—you get the full exit value to inspect. |

```typescript
const mayFail = TIO.fail("oops").fork();

// joinFiber: propagates the error
const joined = mayFail.flatMap((f) => TIO.joinFiber(f));
// This will fail with "oops"

// awaitFiber: captures the exit value
const awaited = mayFail.flatMap((f) => TIO.awaitFiber(f));
// This succeeds with { _tag: "Failure", cause: { _tag: "Fail", error: "oops" } }
```

### When to Use Which

- Use `joinFiber` when you want errors to propagate normally
- Use `awaitFiber` when you need to inspect or handle the exit value yourself

## Interrupting Fibers

Fibers can be interrupted (cancelled) from the outside. This is useful for:
- Timeouts
- Cancelling obsolete work
- Graceful shutdown

```typescript
const longRunning = TIO.succeed("done")
    .delay(10000)  // 10 seconds
    .tap(() => TIO.make(() => console.log("Completed!")));

const program = longRunning.fork().flatMap((fiber) =>
    TIO.sleep(100)                              // Wait 100ms
        .flatMap(() => TIO.interruptFiber(fiber))  // Then interrupt
);

const exit = await runtime.unsafeRun(program);
// exit._tag === "Failure"
// exit.cause._tag === "Interrupt"
// "Completed!" is never printed
```

### How Interruption Works

Interruption in TIO is **cooperative**. When you call `fiber.unsafeInterrupt()`:

1. The fiber is marked as interrupted
2. At the next **async boundary** (await point), the fiber checks if it should stop
3. If interrupted, the fiber completes with a `Cause.Interrupt`

```
Fiber execution:
──► sync code ──► await ──► sync code ──► await ──► sync code ──►
                    ▲                       ▲
                    │                       │
            Interruption check      Interruption check
```

This means:
- **Synchronous code blocks** cannot be interrupted mid-execution
- **Async operations** (delays, I/O) are natural interruption points
- You can add explicit check points with `TIO.checkInterrupted`

```typescript
// This can be interrupted at the delay
const interruptible = TIO.succeed(1).delay(1000);

// This runs to completion even if interrupted (no async boundary)
const notInterruptible = TIO.make(() => {
    let sum = 0;
    for (let i = 0; i < 1000000; i++) sum += i;
    return sum;
});
```

## Racing with Automatic Cancellation

`TIO.raceFirst` runs multiple effects concurrently and returns the first to complete, **automatically interrupting the losers**:

```typescript
const fast = TIO.succeed("fast").delay(50);
const slow = TIO.succeed("slow").delay(200);

const winner = await runtime.unsafeRun(TIO.raceFirst(fast, slow));
// winner === "fast"
// The "slow" fiber is automatically interrupted
```

### Implementing Timeouts

Racing is perfect for implementing timeouts:

```typescript
function withTimeout<R, E, A>(
    effect: TIO<R, E, A>, 
    ms: number
): TIO<R, E | "timeout", A> {
    return TIO.raceFirst(
        effect,
        TIO.sleep(ms).flatMap(() => TIO.fail("timeout" as const))
    );
}

const result = await runtime.unsafeRun(
    withTimeout(TIO.succeed("done").delay(5000), 1000)
);
// Fails with "timeout" after 1 second
```

## Forking Multiple Effects

### TIO.forkAll

Fork an array of effects into fibers:

```typescript
const fibers = await runtime.unsafeRun(
    TIO.forkAll([effect1, effect2, effect3])
);
// fibers: Fiber<E, A>[]
```

### Joining All

Wait for all fibers to complete:

```typescript
const results = await runtime.unsafeRun(
    TIO.forkAll(effects)
        .flatMap((fibers) => TIO.all(...fibers.map(TIO.joinFiber)))
);
```

## Complete Example: Concurrent API Calls

```typescript
import { TIO } from "tio/tio";
import { Runtime } from "tio/runtime";

const runtime = Runtime.default;

// Simulate API calls with different latencies
const fetchUser = TIO.succeed({ id: 1, name: "Alice" }).delay(100);
const fetchOrders = TIO.succeed([{ id: 101 }, { id: 102 }]).delay(150);
const fetchRecommendations = TIO.succeed(["item1", "item2"]).delay(80);

// Fetch all data concurrently with a 200ms timeout
const fetchDashboardData = TIO.forkAll([fetchUser, fetchOrders, fetchRecommendations])
    .flatMap((fibers) => {
        const [userFiber, ordersFiber, recsFiber] = fibers;
        
        return TIO.raceFirst(
            // Wait for all to complete
            TIO.joinFiber(userFiber).flatMap((user) =>
                TIO.joinFiber(ordersFiber).flatMap((orders) =>
                    TIO.joinFiber(recsFiber).map((recommendations) => ({
                        user,
                        orders,
                        recommendations
                    }))
                )
            ),
            // Or timeout after 200ms
            TIO.sleep(200).flatMap(() => TIO.fail("Dashboard load timeout"))
        );
    });

runtime.safeRunEither(fetchDashboardData).then((result) => {
    if (result._tag === "Right") {
        console.log("Dashboard data:", result.value);
    } else {
        console.error("Failed:", result.value);
    }
});
```

## Summary

| Operation | Description |
|-----------|-------------|
| `effect.fork()` | Fork effect into a new fiber |
| `TIO.fork(effect)` | Same as above (static version) |
| `TIO.forkAll(effects)` | Fork multiple effects |
| `TIO.joinFiber(fiber)` | Wait for result, propagate errors |
| `TIO.awaitFiber(fiber)` | Wait for exit value |
| `TIO.interruptFiber(fiber)` | Cancel and wait for exit |
| `TIO.fiberStatus(fiber)` | Get current status |
| `TIO.raceFirst(...effects)` | Race with auto-cancellation |

## Next Steps

- [Error Handling](./error-handling.md) - Understanding Cause and rich error information
- [Core Concepts](./core-concepts.md) - TIO fundamentals

