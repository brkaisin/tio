import { assert, describe, it } from "vitest";
import { TIO } from "../tio/tio";
import { left, right } from "../tio/util/either";
import { Runtime } from "../tio/runtime";
import { failure, success } from "../tio/util/exit";

describe("Runtime", () => {
    const runtime: Runtime<never> = Runtime.default;

    it("unsafeRun", async () => {
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
});

