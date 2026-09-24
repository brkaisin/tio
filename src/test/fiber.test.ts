import { assert, describe, it } from "vitest";
import { TIO } from "../tio/tio";
import { Runtime } from "../tio/runtime";
import {
    combineFiberExits,
    FiberExit,
    fiberFailure,
    FiberStatusTag,
    fiberSuccess,
    InterruptedException,
    isFiberFailure,
    isFiberSuccess
} from "../tio/fiber";
import { CauseTag, fail as causeFail, isDie, isInterrupted, isInterruptedOnly } from "../tio/cause";
import { isLeft, isRight, left } from "../tio/util/either";
import { UIO } from "../tio/aliases";

function assertInterrupted<E, A>(exit: FiberExit<E, A>): void {
    assert.isTrue(isFiberFailure(exit) && isInterruptedOnly(exit.cause), JSON.stringify(exit));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Fiber", () => {
    const runtime: Runtime<never> = Runtime.default;

    describe("fork and join", () => {
        it("should fork an effect and join to get result", async () => {
            const effect = TIO.succeed(42)
                .fork()
                .flatMap((fiber) => TIO.joinFiber(fiber));
            const result = await runtime.unsafeRun(effect);
            assert.equal(result, 42);
        });

        it("should fork a delayed effect", async () => {
            const effect = TIO.succeed(42)
                .delay(10)
                .fork()
                .flatMap((fiber) => TIO.joinFiber(fiber));
            const result = await runtime.unsafeRun(effect);
            assert.equal(result, 42);
        });

        it("should run forked effects in parallel", async () => {
            const results: number[] = [];

            const task1 = TIO.succeed(1)
                .delay(30)
                .tap(() => TIO.make(() => results.push(1)));
            const task2 = TIO.succeed(2)
                .delay(10)
                .tap(() => TIO.make(() => results.push(2)));

            const effect = task1
                .fork()
                .flatMap((f1) => task2.fork().flatMap((f2) => TIO.joinFiber(f1).flatMap(() => TIO.joinFiber(f2))));

            await runtime.unsafeRun(effect);

            // Task2 should complete first because it has shorter delay
            assert.deepEqual(results, [2, 1]);
        });

        it("should propagate errors through joinFiber", async () => {
            const effect = TIO.fail("error")
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.joinFiber(fiber)));

            const result = await runtime.safeRunEither(effect);
            assert.isTrue(isLeft(result));
            if (isLeft(result)) {
                assert.equal(result.left, "error");
            }
        });
    });

    describe("TIO.fork static method", () => {
        it("should work the same as instance fork", async () => {
            const effect = TIO.fork(TIO.succeed(42)).flatMap((fiber) => TIO.joinFiber(fiber));
            const result = await runtime.unsafeRun(effect);
            assert.equal(result, 42);
        });
    });

    describe("TIO.forkAll", () => {
        it("should fork multiple effects", async () => {
            const effects = [TIO.succeed(1), TIO.succeed(2), TIO.succeed(3)];

            const effect = TIO.forkAll(effects).flatMap((fibers) => TIO.all(...fibers.map((f) => TIO.joinFiber(f))));

            const result = await runtime.unsafeRun(effect);
            assert.deepEqual(result, [1, 2, 3]);
        });

        it("should run all effects concurrently", async () => {
            const results: number[] = [];

            const effects = [
                TIO.succeed(1)
                    .delay(30)
                    .tap(() => TIO.make(() => results.push(1))),
                TIO.succeed(2)
                    .delay(10)
                    .tap(() => TIO.make(() => results.push(2))),
                TIO.succeed(3)
                    .delay(20)
                    .tap(() => TIO.make(() => results.push(3)))
            ];

            const effect = TIO.forkAll(effects).flatMap((fibers) => TIO.all(...fibers.map((f) => TIO.joinFiber(f))));

            await runtime.unsafeRun(effect);

            // Should complete in order of delay: 2, 3, 1
            assert.deepEqual(results, [2, 3, 1]);
        });
    });

    describe("await", () => {
        it("should await a successful fiber", async () => {
            const effect = TIO.succeed(42)
                .fork()
                .flatMap((fiber) => TIO.awaitFiber(fiber));
            const result = await runtime.unsafeRun(effect);
            assert.isTrue(isFiberSuccess(result));
            if (isFiberSuccess(result)) {
                assert.equal(result.value, 42);
            }
        });

        it("should await a failed fiber", async () => {
            const effect = TIO.fail("error")
                .fork()
                .flatMap((fiber) => TIO.awaitFiber(fiber));
            const result = await runtime.unsafeRun(effect);
            assert.isTrue(isFiberFailure(result));
            if (isFiberFailure(result)) {
                assert.equal(result.cause._tag, "Fail");
            }
        });

        it("should not propagate errors (unlike joinFiber)", async () => {
            const effect = TIO.fail("error")
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.awaitFiber(fiber)));

            // awaitFiber should succeed even if the fiber fails
            const result = await runtime.safeRunEither(effect);
            assert.isTrue(isRight(result));
        });
    });

    describe("fiberStatus", () => {
        it("should return Running for a running fiber", async () => {
            const effect = TIO.succeed(42)
                .delay(100)
                .fork()
                .flatMap((fiber) => TIO.fiberStatus(fiber));

            const status = await runtime.unsafeRun(effect);
            assert.equal(status._tag, FiberStatusTag.Running);
        });

        it("should return Done for a completed fiber", async () => {
            const effect = TIO.succeed(42)
                .fork()
                .flatMap((fiber) => TIO.joinFiber(fiber).flatMap(() => TIO.fiberStatus(fiber)));

            const status = await runtime.unsafeRun(effect);
            assert.equal(status._tag, FiberStatusTag.Done);
            if (status._tag === FiberStatusTag.Done) {
                assert.isTrue(isFiberSuccess(status.exit));
                if (isFiberSuccess(status.exit)) {
                    assert.equal(status.exit.value, 42);
                }
            }
        });
    });

    describe("interrupt", () => {
        it("should interrupt a long-running fiber", async () => {
            let completed = false;

            const longRunning = TIO.succeed(undefined)
                .delay(100)
                .tap(() =>
                    TIO.make(() => {
                        completed = true;
                    })
                );

            const effect = longRunning
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            const result = await runtime.unsafeRun(effect);
            assert.isTrue(isFiberFailure(result));

            // Give a bit of time for the slow one to potentially complete
            await new Promise((r) => setTimeout(r, 200));
            assert.equal(completed, false);
        });

        it("should return Interrupt cause when interrupted", async () => {
            const effect = TIO.succeed(undefined)
                .delay(1000)
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            const result = await runtime.unsafeRun(effect);

            assert.isTrue(isFiberFailure(result));
            if (isFiberFailure(result)) {
                assert.equal(result.cause._tag, "Interrupt");
            }
        });

        it("should not interrupt an already completed fiber", async () => {
            const effect = TIO.succeed(42)
                .fork()
                .flatMap((fiber) => TIO.joinFiber(fiber).flatMap(() => TIO.interruptFiber(fiber)));

            const result = await runtime.unsafeRun(effect);

            // Should be Success because it completed before interrupt
            assert.isTrue(isFiberSuccess(result));
            if (isFiberSuccess(result)) {
                assert.equal(result.value, 42);
            }
        });
    });

    describe("fiberStatus of a suspended fiber", () => {
        it("should return Suspended for a fiber waiting on an async operation", async () => {
            const effect = TIO.sleep(100)
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.fiberStatus(fiber)));

            const status = await runtime.unsafeRun(effect);
            assert.equal(status._tag, FiberStatusTag.Suspended);
        });
    });

    describe("interruption semantics", () => {
        it("should cancel the pending async operation of an interrupted fiber", async () => {
            let cancelled = false;
            const effect = TIO.async<unknown, never, void>(() => () => {
                cancelled = true;
            })
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.isTrue(cancelled);
        });

        it("should complete the interruption immediately, without waiting for sleeps", async () => {
            const start = Date.now();
            const effect = TIO.sleep(10_000)
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.isBelow(Date.now() - start, 1000);
        });

        it("should run finalizers of an interrupted fiber before interruptFiber completes", async () => {
            const log: string[] = [];
            const effect = TIO.sleep(1000)
                .ensuring(TIO.make(() => log.push("inner finalizer")))
                .ensuring(TIO.sleep(20).flatMap(() => TIO.make(() => log.push("outer finalizer"))))
                .fork()
                .flatMap((fiber) =>
                    TIO.sleep(10)
                        .flatMap(() => TIO.interruptFiber(fiber))
                        .tap(() => TIO.make(() => log.push("interrupted")))
                );

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.deepEqual(log, ["inner finalizer", "outer finalizer", "interrupted"]);
        });

        it("should not let foldM or orElse catch an interruption", async () => {
            let recovered = false;
            const effect = TIO.sleep(1000)
                .orElse(TIO.make(() => (recovered = true)))
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.isFalse(recovered);
        });

        it("should defer interruption until the end of an uninterruptible region", async () => {
            const log: string[] = [];
            const effect = TIO.sleep(50)
                .flatMap(() => TIO.make(() => log.push("uninterruptible done")))
                .uninterruptible()
                .flatMap(() => TIO.make(() => log.push("after region")))
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.deepEqual(log, ["uninterruptible done"]);
        });

        it("should allow interruptible sub-regions with uninterruptibleMask", async () => {
            const log: string[] = [];
            const effect = TIO.uninterruptibleMask((restore) =>
                restore(TIO.sleep(1000)).foldCauseM(
                    (cause) =>
                        TIO.make(() => log.push(`cleanup after ${cause._tag}`)).flatMap(() => TIO.failCause(cause)),
                    () => TIO.make(() => log.push("completed"))
                )
            )
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.deepEqual(log, ["cleanup after Interrupt"]);
        });

        it("should interrupt a fiber that is interrupted before it started", async () => {
            let started = false;
            const effect = TIO.make(() => (started = true))
                .fork()
                .flatMap((fiber) => TIO.interruptFiber(fiber));

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.isFalse(started);
        });

        it("should interrupt a CPU-bound fiber that never suspends", async () => {
            let iterations = 0;
            const loop = (): UIO<never> => TIO.make(() => iterations++).flatMap(loop);

            const effect = loop()
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.isAbove(iterations, 0);
            const iterationsAfterInterruption = iterations;
            await wait(20);
            assert.equal(iterations, iterationsAfterInterruption);
        });

        it("should interrupt the joining fiber when joining an interrupted fiber", async () => {
            const effect = TIO.never
                .fork()
                .flatMap((fiber) => TIO.interruptFiber(fiber).flatMap(() => TIO.joinFiber(fiber)));

            const exit = await runtime.unsafeRun(effect.fork().flatMap(TIO.awaitFiber));
            assertInterrupted(exit);
        });

        it("should reject with InterruptedException when a run is interrupted", async () => {
            const fiber = runtime.unsafeRunFiber(TIO.never);
            const exit = new Promise<FiberExit<never, never>>((resolve) => fiber.unsafeAddObserver(resolve));
            fiber.unsafeInterrupt();
            assertInterrupted(await exit);

            const joinInterrupted = TIO.never
                .fork()
                .flatMap((f) => TIO.interruptFiber(f).flatMap(() => TIO.joinFiber(f)));
            try {
                await runtime.unsafeRun(joinInterrupted);
                assert.fail("Expected unsafeRun to reject");
            } catch (e) {
                assert.instanceOf(e, InterruptedException);
            }
        });
    });

    describe("race", () => {
        it("should return the first effect to complete", async () => {
            const fast = TIO.succeed("fast").delay(10);
            const slow = TIO.succeed("slow").delay(100);

            const result = await runtime.unsafeRun(TIO.race(fast, slow));
            assert.equal(result, "fast");
        });

        it("should interrupt losing fibers", async () => {
            let slowCompleted = false;

            const fast = TIO.succeed("fast").delay(10);
            const slow = TIO.succeed("slow")
                .delay(100)
                .tap(() =>
                    TIO.make(() => {
                        slowCompleted = true;
                    })
                );

            await runtime.unsafeRun(TIO.race(fast, slow));

            // Give a bit of time for the slow one to potentially complete
            await wait(200);

            assert.equal(slowCompleted, false);
        });

        it("should wait for the finalizers of the losers", async () => {
            let loserFinalized = false;
            const fast = TIO.succeed("fast").delay(10);
            const slow = TIO.succeed("slow")
                .delay(1000)
                .ensuring(TIO.sleep(20).flatMap(() => TIO.make(() => (loserFinalized = true))));

            assert.equal(await runtime.unsafeRun(TIO.race(fast, slow)), "fast");
            assert.isTrue(loserFinalized);
        });

        it("should interrupt all racers when the racing fiber is interrupted", async () => {
            let finalized = 0;
            const racer = TIO.never.ensuring(TIO.make(() => finalized++));
            const effect = TIO.race(racer, racer)
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            assertInterrupted(await runtime.unsafeRun(effect));
            assert.equal(finalized, 2);
        });

        it("should return single effect if only one provided", async () => {
            const effect = TIO.succeed(42);
            const result = await runtime.unsafeRun(TIO.race(effect));
            assert.equal(result, 42);
        });

        it("should propagate error from first to fail", async () => {
            const failFast = TIO.sleep(10).flatMap(() => TIO.fail("error"));
            const slow = TIO.succeed("slow").delay(100);

            const result = await runtime.safeRunEither(TIO.race(failFast, slow));
            assert.isTrue(isLeft(result));
            if (isLeft(result)) {
                assert.equal(result.left, "error");
            }
        });
    });

    describe("timeout", () => {
        it("should interrupt the effect when the timeout is reached", async () => {
            let completed = false;
            const effect = TIO.sleep(100)
                .flatMap(() => TIO.make(() => (completed = true)))
                .timeout(10);

            assert.isNull(await runtime.unsafeRun(effect));
            await wait(150);
            assert.isFalse(completed);
        });
    });

    describe("all", () => {
        it("should run effects concurrently", async () => {
            const start = Date.now();
            const result = await runtime.unsafeRun(TIO.all(TIO.succeed(1).delay(50), TIO.succeed(2).delay(50)));
            assert.deepEqual(result, [1, 2]);
            assert.isBelow(Date.now() - start, 95);
        });

        it("should interrupt the other effects as soon as one fails", async () => {
            let completed = false;
            const slow = TIO.sleep(100).flatMap(() => TIO.make(() => (completed = true)));
            const failing = TIO.sleep(10).flatMap(() => TIO.fail("error"));

            const start = Date.now();
            assert.deepEqual(
                await runtime.safeRunEither(TIO.all<unknown, string, unknown>(slow, failing)),
                left("error")
            );
            assert.isBelow(Date.now() - start, 90);
            await wait(150);
            assert.isFalse(completed);
        });

        it("should succeed with an empty array when given no effects", async () => {
            assert.deepEqual(await runtime.unsafeRun(TIO.all()), []);
        });
    });

    describe("defects", () => {
        it("should turn thrown exceptions into defects that are not caught by orElse", async () => {
            const boom = new Error("boom");
            const effect = TIO.make(() => {
                throw boom;
            }).orElse(TIO.succeed("recovered"));

            const exit = await runtime.unsafeRun(effect.fork().flatMap(TIO.awaitFiber));
            assert.isTrue(isFiberFailure(exit) && isDie(exit.cause));

            try {
                await runtime.safeRunEither(effect);
                assert.fail("Expected safeRunEither to reject");
            } catch (e) {
                assert.equal(e, boom);
            }
        });

        it("should combine the failure and the failure of a finalizer with Then", async () => {
            const effect = TIO.fail("error").ensuring(
                TIO.make(() => {
                    throw new Error("cleanup failed");
                })
            );

            const exit = await runtime.unsafeRun(effect.fork().flatMap(TIO.awaitFiber));
            assert.isTrue(isFiberFailure(exit));
            if (isFiberFailure(exit)) assert.equal(exit.cause._tag, CauseTag.Then);
        });
    });

    describe("stack safety", () => {
        it("should run deeply nested flatMaps", async () => {
            const loop = (n: number): UIO<number> => (n === 0 ? TIO.succeed(0) : TIO.succeed(n - 1).flatMap(loop));
            assert.equal(await runtime.unsafeRun(loop(100_000)), 0);
        });

        it("should run left-nested flatMaps", async () => {
            let effect: UIO<number> = TIO.succeed(0);
            for (let i = 0; i < 100_000; i++) effect = effect.map((n) => n + 1);
            assert.equal(await runtime.unsafeRun(effect), 100_000);
        });
    });
});

describe("FiberExit helpers", () => {
    describe("fiberSuccess", () => {
        it("should create a Success exit", () => {
            const exit = fiberSuccess(42);
            assert.isTrue(isFiberSuccess(exit));
            assert.equal(exit.value, 42);
        });
    });

    describe("fiberFailure", () => {
        it("should create a Failure exit", () => {
            const cause = causeFail("error");
            const exit = fiberFailure(cause);
            assert.isTrue(isFiberFailure(exit));
            assert.equal(exit.cause, cause);
        });
    });

    describe("isFiberSuccess", () => {
        it("should return true for Success", () => {
            assert.equal(isFiberSuccess(fiberSuccess(42)), true);
        });

        it("should return false for Failure", () => {
            assert.equal(isFiberSuccess(fiberFailure(causeFail("error"))), false);
        });
    });

    describe("isFiberFailure", () => {
        it("should return true for Failure", () => {
            assert.equal(isFiberFailure(fiberFailure(causeFail("error"))), true);
        });

        it("should return false for Success", () => {
            assert.equal(isFiberFailure(fiberSuccess(42)), false);
        });
    });

    describe("combineFiberExits", () => {
        it("should combine two successes into a tuple", () => {
            const left = fiberSuccess(1);
            const right = fiberSuccess("a");
            const combined = combineFiberExits(left, right);

            assert.isTrue(isFiberSuccess(combined));
            if (isFiberSuccess(combined)) {
                assert.deepEqual(combined.value, [1, "a"]);
            }
        });

        it("should return left failure if left fails", () => {
            const left = fiberFailure<string, number>(causeFail("left error"));
            const right = fiberSuccess("a");
            const combined = combineFiberExits(left, right);

            assert.isTrue(isFiberFailure(combined));
            if (isFiberFailure(combined)) {
                assert.equal(combined.cause._tag, "Fail");
            }
        });

        it("should return right failure if right fails", () => {
            const left = fiberSuccess(1);
            const right = fiberFailure<string, string>(causeFail("right error"));
            const combined = combineFiberExits(left, right);

            assert.isTrue(isFiberFailure(combined));
            if (isFiberFailure(combined)) {
                assert.equal(combined.cause._tag, "Fail");
            }
        });

        it("should combine both failures with Both cause", () => {
            const left = fiberFailure<string, number>(causeFail("left error"));
            const right = fiberFailure<string, string>(causeFail("right error"));
            const combined = combineFiberExits(left, right);

            assert.isTrue(isFiberFailure(combined));
            if (isFiberFailure(combined)) {
                assert.equal(combined.cause._tag, "Both");
            }
        });
    });
});

describe("Runtime fibers", () => {
    const runtime: Runtime<never> = Runtime.default;

    it("should have unique ids", () => {
        const fiber1 = runtime.unsafeRunFiber(TIO.succeed(1));
        const fiber2 = runtime.unsafeRunFiber(TIO.succeed(2));
        assert.notEqual(fiber1.id.id, fiber2.id.id);
    });

    it("should run synchronous effects to completion immediately", () => {
        const fiber = runtime.unsafeRunFiber(TIO.succeed(42));
        const status = fiber.unsafeStatus();
        assert.equal(status._tag, FiberStatusTag.Done);
    });

    it("should notify observers when done", async () => {
        const fiber = runtime.unsafeRunFiber(TIO.succeed(42).delay(10));
        const exit = await new Promise<FiberExit<never, number>>((resolve) => fiber.unsafeAddObserver(resolve));
        assert.deepEqual(exit, fiberSuccess(42));
    });

    it("should immediately notify if already done", () => {
        const fiber = runtime.unsafeRunFiber(TIO.succeed(42));
        let notified = false;
        fiber.unsafeAddObserver(() => {
            notified = true;
        });
        assert.isTrue(notified);
    });

    it("should allow unsubscribing observers", async () => {
        const fiber = runtime.unsafeRunFiber(TIO.succeed(42).delay(10));
        let notified = false;
        const unsubscribe = fiber.unsafeAddObserver(() => {
            notified = true;
        });
        unsubscribe();
        await wait(30);
        assert.isFalse(notified);
    });

    it("should ignore interruption of a completed fiber", () => {
        const fiber = runtime.unsafeRunFiber(TIO.succeed(42));
        fiber.unsafeInterrupt();
        const status = fiber.unsafeStatus();
        assert.isTrue(status._tag === FiberStatusTag.Done && isFiberSuccess(status.exit));
    });

    it("should be interruptible from outside", async () => {
        const fiber = runtime.unsafeRunFiber(TIO.sleep(1000));
        fiber.unsafeInterrupt();
        const exit = await new Promise<FiberExit<never, void>>((resolve) => fiber.unsafeAddObserver(resolve));
        assert.isTrue(isFiberFailure(exit) && isInterrupted(exit.cause));
    });
});

describe("InterruptedException", () => {
    it("should have correct properties", () => {
        const fiberId = { id: 42, startTime: 1000 };
        const exception = new InterruptedException(fiberId);

        assert.equal(exception.fiberId, fiberId);
        assert.equal(exception.name, "InterruptedException");
        assert.include(exception.message, "42");
    });

    it("should be an instance of Error", () => {
        const exception = new InterruptedException({ id: 1, startTime: 0 });
        assert.instanceOf(exception, Error);
    });
});
