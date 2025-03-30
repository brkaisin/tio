import { assert, describe, it } from "vitest"
import { TIO } from "../tio/tio";
import { left, right } from "../tio/util/either";
import { _ } from "../tio/util/typeConstraints";
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
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).tap(x => count = x)), 1);
        assert.equal(count, 1);
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
        assert.equal(await runtime.unsafeRun(TIO.succeed(right("success")).absolve(_)), "success");

        // todo: the following test should also pass with unsafeRun, but runs infinitely...
        assert.deepEqual(await runtime.safeRunEither(TIO.succeed(left("error")).absolve(_)), left("error"));
    });

    // it("catchAll", async () => {
    //     assert.equal(await runtime.unsafeRun((TIO.succeed(1) as IO<unknown, 1>).catchAll((_) => TIO.succeed(2), _)), 1);
    //     assert.equal(await runtime.unsafeRun((TIO.fail(1)).catchAll((_) => TIO.succeed(2), _)), 2);
    // });

    it("zip", async () => {
        assert.deepEqual(await runtime.unsafeRun(TIO.succeed(1).zip(TIO.succeed(2))), [1, 2]);
    });

    it("zipWith", async () => {
        assert.equal(await runtime.unsafeRun(TIO.succeed(1).zipWith(TIO.succeed(2), (x, y) => x + y)), 3);
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
        const p1 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(1), 1000)));
        const p2 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(2), 2000)));
        assert.equal(await runtime.unsafeRun(p1.race(p2)), 1);
        assert.equal(await runtime.unsafeRun(p2.race(p1)), 1); // todo: make this test pass (hard)

        const p3 = TIO.fromPromise(() => new Promise(resolve => {
            for (let i = 0; i < 1; i++) {
            }
            resolve(1);
        }));
        const p4 = TIO.fromPromise(() => new Promise(resolve => {
            for (let i = 0; i < 1000000; i++) {
            }
            resolve(2);
        }));
        assert.equal(await runtime.unsafeRun(p3.race(p4)), 1);
        assert.equal(await runtime.unsafeRun(p4.race(p3)), 1); // todo: make this test pass
    });

    it("raceAll", async () => {
        const p1 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(1), 1000)));
        const p2 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(2), 2000)));
        const p3 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(3), 3000)));
        assert.equal(await runtime.unsafeRun(p1.raceAll(p2, p3)), 1);
    });

    it("timeout", async () => {
        const p1 = TIO.fromPromise(() => new Promise(resolve => setTimeout(() => resolve(1), 1000)));
        assert.equal(await runtime.safeRunUnion(p1.timeout(500)), null);
        assert.equal(await runtime.unsafeRun(p1.timeout(1500)), 1);

        // test with a for loop in promise instead of setTimeout
        // todo: make this test pass (hard)
        const p2 = TIO.fromPromise(() => new Promise(resolve => {
            for (let i = 0; i < 1000000000; i++) {
                if (i === 999999999) {
                    resolve(i);
                }
            }
        }));
        assert.equal(await runtime.safeRunUnion(p2.timeout(10)), null);
        assert.equal(await runtime.unsafeRun(p2.timeout(1500)), 1);
    });

});
