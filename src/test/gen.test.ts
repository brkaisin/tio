import { assert, describe, expectTypeOf, it } from "vitest";
import { TIO } from "../tio/tio";
import { left, right } from "../tio/util/either";
import { Runtime } from "../tio/runtime";
import { Has, tag, Tag } from "../tio/tag";

describe("TIO.gen", () => {
    const runtime: Runtime<never> = Runtime.default;

    const parseId = (input: string): TIO<void, "invalid id", number> =>
        isNaN(Number(input)) ? TIO.fail("invalid id" as const) : TIO.succeed(Number(input));
    const fetchName = (id: number): TIO<void, "not found", string> =>
        id === 42 ? TIO.succeed("Alice") : TIO.fail("not found" as const);

    it("chains effects, with the yielded values in scope", async () => {
        const program = TIO.gen(function* () {
            const a = yield* TIO.succeed(1);
            const b = yield* TIO.succeed(2).delay(10);
            const c = yield* TIO.make(() => 3);
            return a + b + c;
        });
        assert.equal(await runtime.unsafeRun(program), 6);
    });

    it("returns immediately without yielding", async () => {
        assert.equal(
            await runtime.unsafeRun(
                TIO.gen(function* () {
                    return "done";
                })
            ),
            "done"
        );
    });

    it("short-circuits on the first failure", async () => {
        let reached = false;
        const program = TIO.gen(function* () {
            const id = yield* parseId("abc");
            reached = true;
            return yield* fetchName(id);
        });
        assert.deepEqual(await runtime.safeRunEither(program), left("invalid id" as const));
        assert.isFalse(reached);
    });

    it("infers the union of the errors", async () => {
        const program = TIO.gen(function* () {
            const id = yield* parseId("7");
            const name = yield* fetchName(id);
            if (name.length > 10) return yield* TIO.fail("too long" as const);
            return name;
        });
        expectTypeOf(program).toEqualTypeOf<TIO<void, "invalid id" | "not found" | "too long", string>>();
        assert.deepEqual(await runtime.safeRunEither(program), left("not found" as const));
    });

    it("infers the intersection of the environments", async () => {
        const LoggerTag: Tag<"Logger", { log(s: string): void }> = tag("Logger");
        const ConfigTag: Tag<"Config", { greeting: string }> = tag("Config");
        const logs: Array<string> = [];

        const program = TIO.gen(function* () {
            const greeting = yield* TIO.make((env: Has<typeof ConfigTag>) => env.Config.greeting);
            yield* TIO.make((env: Has<typeof LoggerTag>) => env.Logger.log(`${greeting}, world`));
            return greeting.length;
        });
        expectTypeOf(program).toEqualTypeOf<TIO<Has<typeof ConfigTag> & Has<typeof LoggerTag>, never, number>>();

        const configured = Runtime.default
            .provideService(LoggerTag, { log: (s) => logs.push(s) })
            .provideService(ConfigTag, { greeting: "Hello" });
        assert.equal(await configured.unsafeRun(program), 5);
        assert.deepEqual(logs, ["Hello, world"]);
    });

    it("is lazy and can be run multiple times", async () => {
        let runs = 0;
        const program = TIO.gen(function* () {
            runs++;
            const n = yield* TIO.succeed(runs);
            return n * 10;
        });
        assert.equal(runs, 0);
        assert.equal(await runtime.unsafeRun(program), 10);
        assert.equal(await runtime.unsafeRun(program), 20);
    });

    it("can be retried", async () => {
        let attempts = 0;
        const program = TIO.gen(function* () {
            const attempt = yield* TIO.make(() => ++attempts);
            if (attempt < 3) return yield* TIO.fail("flaky");
            return attempt;
        });
        assert.equal(await runtime.unsafeRun(program.retry(5)), 3);
    });

    it("supports loops", async () => {
        const program = TIO.gen(function* () {
            let sum = 0;
            for (let i = 1; i <= 100_000; i++) {
                sum += yield* TIO.succeed(i);
            }
            return sum;
        });
        assert.equal(await runtime.unsafeRun(program), 5_000_050_000);
    });

    it("turns exceptions thrown in the generator into defects", async () => {
        const program = TIO.gen(function* () {
            yield* TIO.succeed(1);
            throw new Error("boom");
        });
        const exit = await new Promise((resolve) => runtime.unsafeRunFiber(program).unsafeAddObserver(resolve));
        assert.deepInclude(exit, { _tag: "Failure" });
        await runtime.unsafeRun(program).then(
            () => assert.fail("should have failed"),
            (e) => assert.equal(e.message, "boom")
        );
    });

    it("works with fibers", async () => {
        const program = TIO.gen(function* () {
            const fiber = yield* TIO.succeed("slow").delay(20).fork();
            const fast = yield* TIO.succeed("fast");
            const slow = yield* TIO.joinFiber(fiber);
            return [fast, slow];
        });
        assert.deepEqual(await runtime.unsafeRun(program), ["fast", "slow"]);
    });

    it("can be interrupted, running the finalizers", async () => {
        let after = false;
        let finalized = false;
        const program = TIO.gen(function* () {
            yield* TIO.sleep(10_000);
            after = true;
        }).ensuring(TIO.make(() => (finalized = true)));

        const fiber = runtime.unsafeRunFiber(program);
        await runtime.unsafeRun(TIO.interruptFiber(fiber).delay(10));
        assert.isFalse(after);
        assert.isTrue(finalized);
    });

    it("handles errors with combinators on yielded effects", async () => {
        const program = TIO.gen(function* () {
            const name = yield* fetchName(1).orElse(TIO.succeed("anonymous"));
            return `Hello, ${name}`;
        });
        expectTypeOf(program).toEqualTypeOf<TIO<unknown, never, string>>();
        assert.deepEqual(await runtime.safeRunEither(program), right("Hello, anonymous"));
    });
});
