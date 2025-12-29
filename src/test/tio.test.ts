import { assert, describe, it } from "vitest"
import { TIO } from "../tio/tio";
import { left, right } from "../tio/util/either";
import { Runtime } from "../tio/runtime";
import { failure, success } from "../tio/util/exit";

describe("TIO", () => {
    const runtime: Runtime<never> = Runtime.default;

    it("succeed", async () => {
        assert.deepEqual(await runtime.safeRunExit(TIO.succeed(1)), success(1));
    });

    it("fail", async () => {
        assert.deepEqual(await runtime.safeRunExit(TIO.fail("error")), failure("error"));
    });

    it("fromPromise", async () => {
        assert.equal(await runtime.unsafeRun(TIO.fromPromise(() => Promise.resolve(1))), 1);
        assert.equal(await runtime.safeRunUnion(TIO.fromPromise(() => Promise.reject("error"))), "error");
        assert.deepEqual(await runtime.safeRunUnion(TIO.fromPromise(() => Promise.reject("error"), (unknownError) =>
            new Error(`Something went wrong: ${unknownError}`))), new Error("Something went wrong: error"));
    });

    // todo: these tests concern the runtime and should go in future dedicated runtime tests
    it("unsafeRunPromise", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1)), 1);
    });

    it("safeRunUnion", async () => {
        assert.equal(await runtime.safeRunUnion(TIO.succeed(1)), 1);
        assert.equal(await runtime.safeRunUnion(TIO.fail("error")), "error");
    });

    it("safeRunEither", async () => {
        assert.deepEqual(await runtime.safeRunEither(TIO.succeed(1)), right(1));
        assert.deepEqual(await runtime.safeRunEither(TIO.fail("error")), left("error"));
    });

    it("safeRunExit", async () => {
        assert.deepEqual(await runtime.safeRunExit(TIO.succeed(1)), success(1));
        assert.deepEqual(await runtime.safeRunExit(TIO.fail("error")), failure("error"));
    });

    it("flatten", async () => {
        assert.equal(await runtime.unsafeRun(TIO.flatten(TIO.succeed(TIO.succeed(1)))), 1);
    });

    it("map", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).map(x => x + 1)), 2);
    });

    it("mapError", async () => {
        assert.equal(await runtime.safeRunUnion(TIO.fail("error").mapError(x => x + "1")), "error1");
    });

    it("mapBoth", async () => {
        assert.equal(await runtime.safeRunUnion(TIO.fail("error").mapBoth(x => x + "1", x => x + 1)), "error1");
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).mapBoth(x => x + "1", x => x + 1)), 2);
    });

    it("flatMap", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).flatMap(x => TIO.succeed(x + 1))), 2);
        assert.equal(await runtime.safeRunUnion(TIO.fail("error").flatMap(x => TIO.fail(x + "1"))), "error");
    });

    it("flatMapError", async () => {
        assert.equal(await runtime.safeRunUnion(TIO.fail("error").flatMapError(x => TIO.succeed(x + "1"))), "error1");
    });

    it("tap", async () => {
        let count = 0;
        const effect = TIO.succeed(1).tap(x => TIO.succeed(count = x));
        assert.equal(await runtime.unsafeRun(effect), 1);
        assert.equal(count, 1);
    });

    it("tapError", async () => {
        let error = "";
        const effect = TIO.fail("error").tapError(e => TIO.succeed(error = e));
        assert.equal(await runtime.safeRunUnion(effect), "error");
        assert.equal(error, "error");
    });

    it("tapBoth", async () => {
        let value = 0;
        let error = "";
        const successEffect = TIO.succeed(1).tapBoth(x => TIO.succeed(value = x), e => TIO.succeed(error = e));
        assert.equal(await runtime.unsafeRun(successEffect), 1);
        assert.equal(value, 1);
        assert.equal(error, "");

        value = 0;
        error = "";
        const failEffect = TIO.fail("error").tapBoth(x => TIO.succeed(value = x), e => TIO.succeed(error = e));
        assert.equal(await runtime.safeRunUnion(failEffect), "error");
        assert.equal(value, 0);
        assert.equal(error, "error");
    });

    it("orElse", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).orElse(TIO.succeed(2))), 1);
        assert.equal(await runtime.unsafeRun(TIO.fail("error").orElse(TIO.succeed(2))), 2);
        assert.equal(await runtime.safeRunUnion(TIO.fail("error1").orElse(TIO.fail("error2"))), "error2");
    });

    it("flip", async () => {
        assert.equal(await runtime.unsafeRun(TIO.fail("error").flip()), "error");
        assert.deepEqual(await runtime.safeRunEither(TIO.succeed(1).flip()), left(1));
    });

    it("flipWith", async () => {
        assert.equal(await runtime.safeRunUnion(TIO.fail("error").flipWith(x => x.map(x => x + "1"))), "error1");
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).flipWith(x => x.mapError(x => x + 1))), 2);
    });

    it("foldM", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).foldM(x => TIO.succeed(x + 1), x => TIO.succeed(x + 2))), 3);
        assert.equal(await runtime.safeRunUnion(TIO.fail("error").foldM(x => TIO.succeed(x + "1"), x => TIO.succeed(x + "2"))), "error1");
    });

    it("fold", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).fold(x => x + 1, x => x + 2)), 3);
        assert.equal(await runtime.safeRunUnion(TIO.fail("error").fold(x => x + "1", x => x + "2")), "error1");
    });

    it("absolve", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(right("success")).absolve()), "success");

        // todo: the following test should also pass with unsafeRun, but runs infinitely...
        assert.deepEqual(await runtime.safeRunEither(TIO.succeed(left("error")).absolve()), left("error"));
    });

    it("augmentError", async () => {
        const narrowError: TIO<void, "specific", number> = TIO.fail("specific");
        const widenedError: TIO<void, string, number> = narrowError.augmentError<string>();
        assert.equal(await runtime.safeRunUnion(widenedError), "specific");
    });

    it("make", async () => {
        const tio = TIO.make((r: { value: number }) => r.value + 1);
        const runtimeWithEnv: Runtime<{ value: number }> = Runtime.withServices({ value: 41 });
        assert.equal(await runtimeWithEnv.unsafeRun(tio), 42);
    });

    it("fromEither", async () => {
        assert.equal(await runtime.unsafeRun(TIO.fromEither(right(1))), 1);
        assert.deepEqual(await runtime.safeRunEither(TIO.fromEither(left("error"))), left("error"));
    });

    it("zip", async () => {
        assert.deepEqual(await runtime.unsafeRun(TIO.succeed(1).zip(TIO.succeed(2))), [1, 2]);
    });

    it("zipLeft", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).zipLeft(TIO.succeed(2))), 1);
    });

    it("zipRight", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).zipRight(TIO.succeed(2))), 2);
    });

    it("zipWith", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).zipWith(TIO.succeed(2), (x, y) => x + y)), 3);
    });

    it("as", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).as("hello")), "hello");
    });

    it("unit", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).unit()), undefined);
    });

    it("delay", async () => {
        const start = Date.now();
        await runtime.unsafeRun(TIO.succeed(1).delay(100));
        const elapsed = Date.now() - start;
        assert.isTrue(elapsed >= 90); // Allow some tolerance
    });

    it("ensuring", async () => {
        let finalizerRan = false;
        const successEffect = TIO.succeed(1).ensuring(TIO.succeed(finalizerRan = true));
        assert.equal(await runtime.unsafeRun(successEffect), 1);
        assert.isTrue(finalizerRan);

        finalizerRan = false;
        const failEffect = TIO.fail("error").ensuring(TIO.succeed(finalizerRan = true));
        assert.equal(await runtime.safeRunUnion(failEffect), "error");
        assert.isTrue(finalizerRan);
    });

    it("retry", async () => {
        let count = 0;
        const p1 = TIO.fromPromise(() => new Promise((resolve, reject) => {
            count++;
            if (count < 3) {
                reject("error");
            } else {
                resolve(1);
            }
        }));
        assert.equal(await runtime.safeRunUnion(p1.retry(0)), "error");
        count = 0;
        assert.equal(await runtime.safeRunUnion(p1.retry(1)), "error");
        count = 0;
        assert.equal(await runtime.unsafeRun(p1.retry(2)), 1);
        count = 0;
        assert.equal(await runtime.unsafeRun(p1.retry(3)), 1);
    });

    it("race", async () => {
        const p1 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(1), 100)));
        const p2 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(2), 200)));
        const p3 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(3), 300)));

        assert.equal(await runtime.unsafeRun(p1.race(p2)), 1);
        assert.equal(await runtime.unsafeRun(p2.race(p1)), 1);
        assert.equal(await runtime.unsafeRun(p1.race(p2, p3)), 1);
        assert.equal(await runtime.unsafeRun(p1.race(p3, p2)), 1);
        assert.equal(await runtime.unsafeRun(p2.race(p1, p3)), 1);
        assert.equal(await runtime.unsafeRun(p2.race(p3, p1)), 1);
        assert.equal(await runtime.unsafeRun(p3.race(p1, p2)), 1);
        assert.equal(await runtime.unsafeRun(p3.race(p2, p1)), 1);

        assert.equal(await runtime.unsafeRun(TIO.race(p1, p2)), 1);
        assert.equal(await runtime.unsafeRun(TIO.race(p2, p1)), 1);
        assert.equal(await runtime.unsafeRun(TIO.race(p1, p2, p3)), 1);
        assert.equal(await runtime.unsafeRun(TIO.race(p3, p2, p1)), 1);

        const p4 = TIO.fromPromise(() => new Promise(resolve => {
            for (let i = 0; i < 1; i++) {
            }
            resolve(1);
        }));
        const p5 = TIO.fromPromise(() => new Promise(resolve => {
            for (let i = 0; i < 1000000; i++) {
            }
            resolve(2);
        }));
        assert.equal(await runtime.unsafeRun(p4.race(p5)), 1);
        // Note: p5 resolves to 2 because synchronous operations in Promise executors run to completion
        // before any other code executes. Since p5 is called first, its for-loop completes before p4 starts.
        // This is a fundamental limitation of JavaScript's single-threaded nature.
        assert.equal(await runtime.unsafeRun(p5.race(p4)), 2);
    });

    it("timeout", async () => {
        const p1 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(1), 1000)));
        assert.equal(await runtime.safeRunUnion(p1.timeout(500)), null);
        assert.equal(await runtime.unsafeRun(p1.timeout(1500)), 1);

        // Note: Synchronous for-loops in Promise executors cannot be interrupted by timeout
        // because JavaScript is single-threaded. The loop runs to completion before any
        // timeout callback can execute. This is a fundamental limitation of JavaScript.
        const p2 = TIO.fromPromise(() => new Promise(resolve => {
            for (let i = 0; i < 1000000; i++) {
                if (i === 999999) {
                    resolve(i);
                }
            }
        }));
        // Both assertions expect the loop result (999999) since the synchronous loop
        // completes before the timeout can fire, regardless of timeout duration.
        assert.equal(await runtime.safeRunUnion(p2.timeout(10)), 999999);
        assert.equal(await runtime.unsafeRun(p2.timeout(1500)), 999999);
    });

    it("all", async () => {
        const p1 = TIO.succeed(1);
        const p2 = TIO.succeed(2);
        const p3 = TIO.succeed(3);
        assert.deepEqual(await runtime.unsafeRun(TIO.all(p1, p2, p3)), [1, 2, 3]);

        // Test that all fails if one fails
        const pFail = TIO.fail("error");
        assert.equal(await runtime.safeRunUnion(TIO.all(p1, pFail, p3)), "error");
    });

    it("sleep", async () => {
        const start = Date.now();
        await runtime.unsafeRun(TIO.sleep(100));
        const elapsed = Date.now() - start;
        assert.isTrue(elapsed >= 90); // Allow some tolerance
    });

});
