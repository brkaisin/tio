import { describe, it, assert } from "vitest";
import { TIO } from "../tio/tio";
import { Runtime } from "../tio/runtime";
import {
    FiberContext,
    fiberSuccess,
    fiberFailure,
    isFiberSuccess,
    isFiberFailure,
    combineFiberExits,
    InterruptedException
} from "../tio/fiber";
import { fail as causeFail, both, interrupt as causeInterrupt } from "../tio/cause";

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
            assert.isTrue("left" in result);
            if ("left" in result) {
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
            assert.equal(result._tag, "Success");
            if (result._tag === "Success") {
                assert.equal(result.value, 42);
            }
        });

        it("should await a failed fiber", async () => {
            const effect = TIO.fail("error")
                .fork()
                .flatMap((fiber) => TIO.awaitFiber(fiber));
            const result = await runtime.unsafeRun(effect);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") {
                assert.equal(result.cause._tag, "Fail");
            }
        });

        it("should not propagate errors (unlike joinFiber)", async () => {
            const effect = TIO.fail("error")
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.awaitFiber(fiber)));

            // awaitFiber should succeed even if the fiber fails
            const result = await runtime.safeRunEither(effect);
            assert.isTrue("right" in result);
        });
    });

    describe("fiberStatus", () => {
        it("should return Running for a running fiber", async () => {
            const effect = TIO.succeed(42)
                .delay(100)
                .fork()
                .flatMap((fiber) => TIO.fiberStatus(fiber));

            const status = await runtime.unsafeRun(effect);
            assert.equal(status._tag, "Running");
        });

        it("should return Done for a completed fiber", async () => {
            const effect = TIO.succeed(42)
                .fork()
                .flatMap((fiber) => TIO.joinFiber(fiber).flatMap(() => TIO.fiberStatus(fiber)));

            const status = await runtime.unsafeRun(effect);
            assert.equal(status._tag, "Done");
            if (status._tag === "Done") {
                assert.equal(status.exit._tag, "Success");
            }
        });
    });

    describe("interrupt", () => {
        it("should interrupt a long-running fiber", async () => {
            let completed = false;

            const longRunning = TIO.succeed(undefined)
                .delay(1000)
                .tap(() =>
                    TIO.make(() => {
                        completed = true;
                    })
                );

            const effect = longRunning
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            const result = await runtime.unsafeRun(effect);

            assert.equal(result._tag, "Failure");
            assert.equal(completed, false);
        });

        it("should return Interrupt cause when interrupted", async () => {
            const effect = TIO.succeed(undefined)
                .delay(1000)
                .fork()
                .flatMap((fiber) => TIO.sleep(10).flatMap(() => TIO.interruptFiber(fiber)));

            const result = await runtime.unsafeRun(effect);

            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") {
                assert.equal(result.cause._tag, "Interrupt");
            }
        });

        it("should not interrupt an already completed fiber", async () => {
            const effect = TIO.succeed(42)
                .fork()
                .flatMap((fiber) => TIO.joinFiber(fiber).flatMap(() => TIO.interruptFiber(fiber)));

            const result = await runtime.unsafeRun(effect);

            // Should be Success because it completed before interrupt
            assert.equal(result._tag, "Success");
            if (result._tag === "Success") {
                assert.equal(result.value, 42);
            }
        });
    });

    describe("raceFirst", () => {
        it("should return the first effect to complete", async () => {
            const fast = TIO.succeed("fast").delay(10);
            const slow = TIO.succeed("slow").delay(100);

            const result = await runtime.unsafeRun(TIO.raceFirst(fast, slow));
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

            await runtime.unsafeRun(TIO.raceFirst(fast, slow));

            // Give a bit of time for the slow one to potentially complete
            await new Promise((r) => setTimeout(r, 50));

            assert.equal(slowCompleted, false);
        });

        it("should return single effect if only one provided", async () => {
            const effect = TIO.succeed(42);
            const result = await runtime.unsafeRun(TIO.raceFirst(effect));
            assert.equal(result, 42);
        });

        it("should propagate error from first to fail", async () => {
            const failFast = TIO.sleep(10).flatMap(() => TIO.fail("error"));
            const slow = TIO.succeed("slow").delay(100);

            const result = await runtime.safeRunEither(TIO.raceFirst(failFast, slow));
            assert.isTrue("left" in result);
            if ("left" in result) {
                assert.equal(result.left, "error");
            }
        });
    });
});

describe("FiberExit helpers", () => {
    describe("fiberSuccess", () => {
        it("should create a Success exit", () => {
            const exit = fiberSuccess(42);
            assert.equal(exit._tag, "Success");
            assert.equal(exit.value, 42);
        });
    });

    describe("fiberFailure", () => {
        it("should create a Failure exit", () => {
            const cause = causeFail("error");
            const exit = fiberFailure(cause);
            assert.equal(exit._tag, "Failure");
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

            assert.equal(combined._tag, "Success");
            if (combined._tag === "Success") {
                assert.deepEqual(combined.value, [1, "a"]);
            }
        });

        it("should return left failure if left fails", () => {
            const left = fiberFailure<string, number>(causeFail("left error"));
            const right = fiberSuccess("a");
            const combined = combineFiberExits(left, right);

            assert.equal(combined._tag, "Failure");
            if (combined._tag === "Failure") {
                assert.equal(combined.cause._tag, "Fail");
            }
        });

        it("should return right failure if right fails", () => {
            const left = fiberSuccess(1);
            const right = fiberFailure<string, string>(causeFail("right error"));
            const combined = combineFiberExits(left, right);

            assert.equal(combined._tag, "Failure");
            if (combined._tag === "Failure") {
                assert.equal(combined.cause._tag, "Fail");
            }
        });

        it("should combine both failures with Both cause", () => {
            const left = fiberFailure<string, number>(causeFail("left error"));
            const right = fiberFailure<string, string>(causeFail("right error"));
            const combined = combineFiberExits(left, right);

            assert.equal(combined._tag, "Failure");
            if (combined._tag === "Failure") {
                assert.equal(combined.cause._tag, "Both");
            }
        });
    });
});

describe("FiberContext", () => {
    it("should have a unique id", () => {
        const fiber1 = new FiberContext();
        const fiber2 = new FiberContext();
        assert.notEqual(fiber1.id.id, fiber2.id.id);
    });

    it("should start in Running state", () => {
        const fiber = new FiberContext();
        const status = fiber.unsafeStatus();
        assert.equal(status._tag, "Running");
    });

    it("should transition to Done after done() is called", () => {
        const fiber = new FiberContext<never, number>();
        fiber.done(fiberSuccess(42));
        const status = fiber.unsafeStatus();
        assert.equal(status._tag, "Done");
    });

    it("should notify observers when done", () => {
        const fiber = new FiberContext<never, number>();
        let notified = false;

        fiber.unsafeAddObserver(() => {
            notified = true;
        });

        fiber.done(fiberSuccess(42));
        assert.equal(notified, true);
    });

    it("should immediately notify if already done", () => {
        const fiber = new FiberContext<never, number>();
        fiber.done(fiberSuccess(42));

        let notified = false;
        fiber.unsafeAddObserver(() => {
            notified = true;
        });

        assert.equal(notified, true);
    });

    it("should allow unsubscribing observers", () => {
        const fiber = new FiberContext<never, number>();
        let notified = false;

        const unsubscribe = fiber.unsafeAddObserver(() => {
            notified = true;
        });

        unsubscribe();
        fiber.done(fiberSuccess(42));

        assert.equal(notified, false);
    });

    it("should not call done twice", () => {
        const fiber = new FiberContext<never, number>();
        let callCount = 0;

        fiber.unsafeAddObserver(() => {
            callCount++;
        });

        fiber.done(fiberSuccess(42));
        fiber.done(fiberSuccess(100)); // Should be ignored

        assert.equal(callCount, 1);

        const status = fiber.unsafeStatus();
        if (status._tag === "Done" && status.exit._tag === "Success") {
            assert.equal(status.exit.value, 42); // First value wins
        }
    });
});

describe("InterruptedException", () => {
    it("should have correct properties", () => {
        const fiberId = { id: 42, startTime: 1000 };
        const exception = new InterruptedException(fiberId);

        assert.equal(exception._tag, "InterruptedException");
        assert.equal(exception.fiberId, fiberId);
        assert.equal(exception.name, "InterruptedException");
        assert.include(exception.message, "42");
    });

    it("should be an instance of Error", () => {
        const exception = new InterruptedException({ id: 1, startTime: 0 });
        assert.instanceOf(exception, Error);
    });
});
