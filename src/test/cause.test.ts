import { assert, describe, it } from "vitest";
import {
    both,
    defects,
    die,
    empty,
    fail,
    failures,
    interrupt,
    interruptors,
    isDie,
    isEmpty,
    isFailure,
    isInterrupted,
    makeFiberId,
    map,
    prettyPrint,
    sequential,
    squash
} from "../tio/cause";

describe("Cause", () => {
    // Test FiberIds for use in tests
    const fiberId1 = { id: 1, startTime: 1000 };
    const fiberId2 = { id: 2, startTime: 2000 };

    describe("constructors", () => {
        it("should create an Empty cause", () => {
            assert.equal(empty._tag, "Empty");
        });

        it("should create a Fail cause", () => {
            const cause = fail("error");
            assert.equal(cause._tag, "Fail");
            if (cause._tag === "Fail") {
                assert.equal(cause.error, "error");
            }
        });

        it("should create a Die cause", () => {
            const error = new Error("unexpected");
            const cause = die(error);
            assert.equal(cause._tag, "Die");
            if (cause._tag === "Die") {
                assert.equal(cause.defect, error);
            }
        });

        it("should create an Interrupt cause", () => {
            const cause = interrupt(fiberId1);
            assert.equal(cause._tag, "Interrupt");
            if (cause._tag === "Interrupt") {
                assert.equal(cause.fiberId, fiberId1);
            }
        });

        it("should create a Then cause for sequential failures", () => {
            const cause = sequential(fail("first"), fail("second"));
            assert.equal(cause._tag, "Then");
            if (cause._tag === "Then") {
                assert.equal(cause.left._tag, "Fail");
                assert.equal(cause.right._tag, "Fail");
            }
        });

        it("should create a Both cause for parallel failures", () => {
            const cause = both(fail("left"), fail("right"));
            assert.equal(cause._tag, "Both");
            if (cause._tag === "Both") {
                assert.equal(cause.left._tag, "Fail");
                assert.equal(cause.right._tag, "Fail");
            }
        });

        it("sequential should return right if left is empty", () => {
            const cause = sequential(empty, fail("error"));
            assert.equal(cause._tag, "Fail");
        });

        it("sequential should return left if right is empty", () => {
            const cause = sequential(fail("error"), empty);
            assert.equal(cause._tag, "Fail");
        });

        it("both should return right if left is empty", () => {
            const cause = both(empty, fail("error"));
            assert.equal(cause._tag, "Fail");
        });

        it("both should return left if right is empty", () => {
            const cause = both(fail("error"), empty);
            assert.equal(cause._tag, "Fail");
        });
    });

    describe("predicates", () => {
        describe("isEmpty", () => {
            it("should return true for Empty", () => {
                assert.equal(isEmpty(empty), true);
            });

            it("should return false for Fail", () => {
                assert.equal(isEmpty(fail("error")), false);
            });

            it("should return false for Die", () => {
                assert.equal(isEmpty(die(new Error())), false);
            });
        });

        describe("isFailure", () => {
            it("should return true for Fail", () => {
                assert.equal(isFailure(fail("error")), true);
            });

            it("should return false for Empty", () => {
                assert.equal(isFailure(empty), false);
            });

            it("should return false for Die", () => {
                assert.equal(isFailure(die(new Error())), false);
            });

            it("should return false for Interrupt", () => {
                assert.equal(isFailure(interrupt(fiberId1)), false);
            });

            it("should return true for Then containing Fail", () => {
                assert.equal(isFailure(sequential(fail("error"), empty)), true);
            });

            it("should return true for Both containing Fail", () => {
                assert.equal(isFailure(both(die(new Error()), fail("error"))), true);
            });

            it("should return false for Then without Fail", () => {
                assert.equal(isFailure(sequential(die(new Error()), interrupt(fiberId1))), false);
            });
        });

        describe("isInterrupted", () => {
            it("should return true for Interrupt", () => {
                assert.equal(isInterrupted(interrupt(fiberId1)), true);
            });

            it("should return false for Empty", () => {
                assert.equal(isInterrupted(empty), false);
            });

            it("should return false for Fail", () => {
                assert.equal(isInterrupted(fail("error")), false);
            });

            it("should return true for Then containing Interrupt", () => {
                assert.equal(isInterrupted(sequential(fail("error"), interrupt(fiberId1))), true);
            });

            it("should return true for Both containing Interrupt", () => {
                assert.equal(isInterrupted(both(interrupt(fiberId1), fail("error"))), true);
            });
        });

        describe("isDie", () => {
            it("should return true for Die", () => {
                assert.equal(isDie(die(new Error())), true);
            });

            it("should return false for Empty", () => {
                assert.equal(isDie(empty), false);
            });

            it("should return false for Fail", () => {
                assert.equal(isDie(fail("error")), false);
            });

            it("should return true for Then containing Die", () => {
                assert.equal(isDie(sequential(die(new Error()), fail("error"))), true);
            });

            it("should return true for Both containing Die", () => {
                assert.equal(isDie(both(fail("error"), die(new Error()))), true);
            });
        });
    });

    describe("extractors", () => {
        describe("failures", () => {
            it("should return empty array for Empty", () => {
                assert.deepEqual(failures(empty), []);
            });

            it("should return the error for Fail", () => {
                assert.deepEqual(failures(fail("error")), ["error"]);
            });

            it("should return empty array for Die", () => {
                assert.deepEqual(failures(die(new Error())), []);
            });

            it("should return empty array for Interrupt", () => {
                assert.deepEqual(failures(interrupt(fiberId1)), []);
            });

            it("should collect all failures from Then", () => {
                const cause = sequential(fail("first"), fail("second"));
                assert.deepEqual(failures(cause), ["first", "second"]);
            });

            it("should collect all failures from Both", () => {
                const cause = both(fail("left"), fail("right"));
                assert.deepEqual(failures(cause), ["left", "right"]);
            });

            it("should collect failures from nested causes", () => {
                const cause = both(sequential(fail("a"), fail("b")), both(fail("c"), die(new Error())));
                assert.deepEqual(failures(cause), ["a", "b", "c"]);
            });
        });

        describe("defects", () => {
            it("should return empty array for Empty", () => {
                assert.deepEqual(defects(empty), []);
            });

            it("should return empty array for Fail", () => {
                assert.deepEqual(defects(fail("error")), []);
            });

            it("should return the defect for Die", () => {
                const error = new Error("defect");
                assert.deepEqual(defects(die(error)), [error]);
            });

            it("should collect all defects from nested causes", () => {
                const error1 = new Error("defect1");
                const error2 = new Error("defect2");
                const cause = both(die(error1), sequential(fail("error"), die(error2)));
                assert.deepEqual(defects(cause), [error1, error2]);
            });
        });

        describe("interruptors", () => {
            it("should return empty array for Empty", () => {
                assert.deepEqual(interruptors(empty), []);
            });

            it("should return empty array for Fail", () => {
                assert.deepEqual(interruptors(fail("error")), []);
            });

            it("should return the fiberId for Interrupt", () => {
                assert.deepEqual(interruptors(interrupt(fiberId1)), [fiberId1]);
            });

            it("should collect all interruptors from nested causes", () => {
                const cause = both(interrupt(fiberId1), sequential(fail("error"), interrupt(fiberId2)));
                assert.deepEqual(interruptors(cause), [fiberId1, fiberId2]);
            });
        });
    });

    describe("transformations", () => {
        describe("map", () => {
            it("should not change Empty", () => {
                const result = map(empty, (x: string) => x.toUpperCase());
                assert.equal(result._tag, "Empty");
            });

            it("should transform Fail error", () => {
                const result = map(fail("error"), (x) => x.toUpperCase());
                assert.equal(result._tag, "Fail");
                if (result._tag === "Fail") {
                    assert.equal(result.error, "ERROR");
                }
            });

            it("should not change Die", () => {
                const error = new Error("defect");
                const result = map(die(error), (x: string) => x.toUpperCase());
                assert.equal(result._tag, "Die");
                if (result._tag === "Die") {
                    assert.equal(result.defect, error);
                }
            });

            it("should not change Interrupt", () => {
                const result = map(interrupt(fiberId1), (x: string) => x.toUpperCase());
                assert.equal(result._tag, "Interrupt");
            });

            it("should transform nested Fail errors in Then", () => {
                const cause = sequential(fail("first"), fail("second"));
                const result = map(cause, (x) => x.toUpperCase());
                assert.deepEqual(failures(result), ["FIRST", "SECOND"]);
            });

            it("should transform nested Fail errors in Both", () => {
                const cause = both(fail("left"), fail("right"));
                const result = map(cause, (x) => x.toUpperCase());
                assert.deepEqual(failures(result), ["LEFT", "RIGHT"]);
            });
        });
    });

    describe("squash", () => {
        it("should return undefined for Empty", () => {
            assert.equal(squash(empty), undefined);
        });

        it("should return the error for Fail", () => {
            assert.equal(squash(fail("error")), "error");
        });

        it("should return the defect for Die when no Fail", () => {
            const error = new Error("defect");
            assert.equal(squash(die(error)), error);
        });

        it("should return the fiberId for Interrupt when no Fail or Die", () => {
            assert.equal(squash(interrupt(fiberId1)), fiberId1);
        });

        it("should prioritize Fail over Die", () => {
            const cause = both(die(new Error()), fail("error"));
            assert.equal(squash(cause), "error");
        });

        it("should prioritize Die over Interrupt", () => {
            const error = new Error("defect");
            const cause = both(interrupt(fiberId1), die(error));
            assert.equal(squash(cause), error);
        });

        it("should return first failure when multiple", () => {
            const cause = both(fail("first"), fail("second"));
            assert.equal(squash(cause), "first");
        });
    });

    describe("prettyPrint", () => {
        it("should print Empty", () => {
            assert.equal(prettyPrint(empty), "Empty");
        });

        it("should print Fail", () => {
            assert.equal(prettyPrint(fail("error")), "Fail(error)");
        });

        it("should print Die", () => {
            assert.equal(prettyPrint(die("defect")), "Die(defect)");
        });

        it("should print Interrupt", () => {
            assert.equal(prettyPrint(interrupt(fiberId1)), "Interrupt(Fiber#1)");
        });

        it("should print Then", () => {
            const cause = sequential(fail("first"), fail("second"));
            assert.equal(prettyPrint(cause), "Then(Fail(first), Fail(second))");
        });

        it("should print Both", () => {
            const cause = both(fail("left"), fail("right"));
            assert.equal(prettyPrint(cause), "Both(Fail(left), Fail(right))");
        });

        it("should print nested causes", () => {
            const cause = both(sequential(fail("a"), die("b")), interrupt(fiberId2));
            assert.equal(prettyPrint(cause), "Both(Then(Fail(a), Die(b)), Interrupt(Fiber#2))");
        });
    });

    describe("makeFiberId", () => {
        it("should create unique fiber ids", () => {
            const id1 = makeFiberId();
            const id2 = makeFiberId();
            assert.notEqual(id1.id, id2.id);
        });

        it("should include a startTime", () => {
            const id = makeFiberId();
            assert.isNumber(id.startTime);
            assert.isAtLeast(id.startTime, 0);
        });
    });
});
