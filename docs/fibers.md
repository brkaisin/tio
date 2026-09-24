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

Every TIO program runs in a fiber: `runtime.unsafeRun(effect)` starts a root fiber. A fiber interprets the effect
step by step, keeping an explicit stack of continuations (so deeply nested `flatMap`s are stack-safe). It:

- runs synchronous steps one after the other,
- suspends when waiting on an async operation (a timer, a Promise, another fiber...), letting other fibers run,
- yields to the event loop every few thousand steps, so that a CPU-bound fiber doesn't starve the others.

When you call `.fork()` on an effect, TIO creates a new fiber that starts running the effect concurrently,
and returns immediately with a `Fiber` handle. You can:
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
| `Running` | The fiber is executing (or about to start) |
| `Suspended` | The fiber is waiting on an async operation (e.g., I/O or a timer) |
| `Done` | The fiber has completed with a `FiberExit` |

You can check a fiber's status:

```typescript
const status = await runtime.unsafeRun(TIO.fiberStatus(fiber));
// { _tag: "Running" } or { _tag: "Suspended" } or { _tag: "Done", exit: ... }
```

## FiberExit

A `FiberExit<E, A>` represents how a fiber completed:

```typescript
type FiberSuccess<A> = { readonly _tag: FiberTag.Success; readonly value: A };
type FiberFailure<E> = { readonly _tag: FiberTag.Failure; readonly cause: Cause<E> };

type FiberExit<E, A> =
    | FiberSuccess<A>        // Completed successfully
    | FiberFailure<E> // Failed with a Cause
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

`TIO.interruptFiber(fiber)` requests the interruption of the fiber, then waits for it to complete.

1. The fiber is marked as interrupted.
2. If it is suspended on an async operation, the operation is cancelled (e.g. the timer of `TIO.sleep` is cleared)
   and the fiber resumes immediately. Otherwise, the interruption is picked up before its next step.
3. The fiber unwinds its stack, running all its finalizers (see below), and completes with an `Interrupt` cause.
4. `interruptFiber` returns the exit of the fiber, once all its finalizers are done.

```
Fiber execution:
──► step ──► step ──► async (suspended) ──► step ──►
  ▲        ▲        ▲       ▲
  └────────┴────────┴───────┴── interruption points
```

This means:
- A **single synchronous step** (e.g. a `TIO.make` callback) cannot be interrupted in the middle of its execution
- Everything between steps, including async operations, is interruptible
- An interrupted fiber cannot "recover": `foldM`, `orElse`, etc. do not catch interruptions

```typescript
// This can be interrupted during the delay
const interruptible = TIO.succeed(1).delay(1000);

// This single step runs to completion even if interrupted
const notInterruptible = TIO.make(() => {
    let sum = 0;
    for (let i = 0; i < 1000000; i++) sum += i;
    return sum;
});
```

### Finalizers

Finalizers registered with `ensuring` always run: on success, on failure, and on interruption.
Finalizers themselves are uninterruptible, so they run to completion.

```typescript
const program = acquireConnection.flatMap((conn) =>
    useConnection(conn).ensuring(closeConnection(conn))
);
// closeConnection runs even if the fiber running `program` is interrupted
```

### Uninterruptible Regions

Some sections must not be interrupted halfway. Mark them `uninterruptible()`: an interruption received in the region
is deferred until the region is exited.

```typescript
const transfer = withdraw(from, amount)
    .flatMap(() => deposit(to, amount))
    .uninterruptible(); // either both happen, or none
```

`TIO.uninterruptibleMask` runs an effect uninterruptibly, while allowing some parts to be interrupted again with
`restore`. This is how you can write safe resource handling, where acquisition and release are uninterruptible but
the usage is interruptible:

```typescript
const bracket = <R, E, A, B>(
    acquire: TIO<R, E, A>,
    release: (a: A) => TIO<R, never, unknown>,
    use: (a: A) => TIO<R, E, B>
): TIO<R, E, B> =>
    TIO.uninterruptibleMask((restore) => acquire.flatMap((a) => restore(use(a)).ensuring(release(a))));
```

Forked fibers always start interruptible, even when forked from an uninterruptible region.

### Cancellable Async Operations

`TIO.async` can return a *canceler*, called when the fiber is interrupted while waiting for the operation.
Use it to release what the operation holds:

```typescript
const fetchWithAbort = (url: string) =>
    TIO.async<unknown, Error, Response>((_, resolve, reject) => {
        const controller = new AbortController();
        fetch(url, { signal: controller.signal }).then(resolve, reject);
        return () => controller.abort();
    });
```

Without a canceler, the interrupted fiber still stops waiting immediately; the result of the operation is ignored.

### Interrupting from Outside

`runtime.unsafeRunFiber(effect)` starts the effect and returns its root fiber. This is useful to cancel a whole
program, for example on shutdown:

```typescript
const fiber = runtime.unsafeRunFiber(server);
process.on("SIGINT", () => fiber.unsafeInterrupt());
```

When the root fiber of `unsafeRun`, `safeRunEither`, etc. is interrupted, the returned Promise is rejected with
an `InterruptedException`.

## Racing with Automatic Cancellation

`TIO.race` (or `effect.race(...)`) runs multiple effects concurrently and returns the first to complete
(successfully or not), **automatically interrupting the losers**:

```typescript
const fast = TIO.succeed("fast").delay(50);
const slow = TIO.succeed("slow").delay(200);

const winner = await runtime.unsafeRun(TIO.race(fast, slow));
// winner === "fast"
// The "slow" fiber is interrupted, and its finalizers have run
```

If the racing fiber is itself interrupted, all the racers are interrupted too.

`TIO.all` is the counterpart of `race`: it runs effects concurrently and collects all their results.
If one of them fails, the others are interrupted.

### Implementing Timeouts

Racing is perfect for implementing timeouts. `effect.timeout(ms)` returns `null` if the effect doesn't complete in
time (the effect is then interrupted). You can also use `race` directly to fail instead:

```typescript
function withTimeout<R, E, A>(
    effect: TIO<R, E, A>, 
    ms: number
): TIO<R, E | "timeout", A> {
    return TIO.race<R, E | "timeout", A>(
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
import { isRight } from "tio/util/either";

const runtime = Runtime.default;

// Simulate API calls with different latencies
const fetchUser = TIO.succeed({ id: 1, name: "Alice" }).delay(100);
const fetchOrders = TIO.succeed([{ id: 101 }, { id: 102 }]).delay(150);
const fetchRecommendations = TIO.succeed(["item1", "item2"]).delay(80);

// Fetch all data concurrently with a 200ms timeout
// Fork each effect individually to preserve types
const fetchDashboardData = fetchUser.fork().flatMap((userFiber) =>
    fetchOrders.fork().flatMap((ordersFiber) =>
        fetchRecommendations.fork().flatMap((recsFiber) => {
            return TIO.race(
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
                TIO.sleep(200).flatMap(() => TIO.fail("Dashboard load timeout" as const))
            );
        })
    )
);

runtime.safeRunEither(fetchDashboardData).then((result) => {
    if (isRight(result)) {
        console.log("Dashboard data:", result.right);
    } else {
        console.error("Failed:", result.left);
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
| `TIO.interruptFiber(fiber)` | Interrupt and wait for exit |
| `TIO.interruptAll(fibers)` | Interrupt all and wait for their exits |
| `TIO.fiberStatus(fiber)` | Get current status |
| `TIO.race(...effects)` | Race with auto-cancellation of the losers |
| `TIO.all(...effects)` | Run concurrently, fail fast and interrupt the others |
| `effect.timeout(ms)` | Interrupt the effect after `ms` |
| `effect.ensuring(finalizer)` | Run a finalizer, even on interruption |
| `effect.uninterruptible()` | Defer interruptions until the effect is done |
| `TIO.uninterruptibleMask(f)` | Uninterruptible, with interruptible parts |
| `runtime.unsafeRunFiber(effect)` | Run and get the root fiber |

## Next Steps

- [Error Handling](./error-handling.md) - Understanding Cause and rich error information
- [Core Concepts](./core-concepts.md) - TIO fundamentals

