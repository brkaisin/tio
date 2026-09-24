import { both, Cause, FiberId } from "./cause";

export const enum FiberStatusTag {
    Running = "Running",
    Suspended = "Suspended",
    Done = "Done"
}

/**
 * FiberStatus represents the current state of a Fiber.
 */
export type FiberStatus<E, A> =
    | { readonly _tag: FiberStatusTag.Running }
    | { readonly _tag: FiberStatusTag.Suspended }
    | { readonly _tag: FiberStatusTag.Done; readonly exit: FiberExit<E, A> };

export const enum FiberTag {
    Success = "Success",
    Failure = "Failure"
}

type FiberSuccess<A> = { readonly _tag: FiberTag.Success; readonly value: A };
type FiberFailure<E> = { readonly _tag: FiberTag.Failure; readonly cause: Cause<E> };

/**
 * FiberExit is the result of a Fiber completing.
 * Unlike Exit, it uses Cause for richer failure information.
 */
export type FiberExit<E, A> = FiberSuccess<A> | FiberFailure<E>;

export function fiberSuccess<E, A>(value: A): FiberSuccess<A> {
    return { _tag: FiberTag.Success, value };
}

export function fiberFailure<E, A>(cause: Cause<E>): FiberFailure<E> {
    return { _tag: FiberTag.Failure, cause };
}

export function isFiberSuccess<E, A>(exit: FiberExit<E, A>): exit is FiberSuccess<A> {
    return exit._tag === FiberTag.Success;
}

export function isFiberFailure<E, A>(exit: FiberExit<E, A>): exit is FiberFailure<E> {
    return exit._tag === FiberTag.Failure;
}

/**
 * Fiber represents a running effect that can be observed or interrupted.
 *
 * - `unsafeAddObserver` registers a callback called with the exit of the fiber (immediately if already done).
 *   It returns a function removing the observer.
 * - `unsafeInterrupt` requests the interruption of the fiber. It is asynchronous: the fiber stops at its
 *   next step (or immediately if it is waiting on an async operation), after running its finalizers.
 *   Use `TIO.interruptFiber` to wait for the interruption to complete.
 */
export interface Fiber<E, A> {
    readonly id: FiberId;
    readonly unsafeAddObserver: (callback: (exit: FiberExit<E, A>) => void) => () => void;
    readonly unsafeInterrupt: () => void;
    readonly unsafeStatus: () => FiberStatus<E, A>;
}

/**
 * Error used to reject the Promise of a run whose fiber was interrupted.
 */
export class InterruptedException extends Error {
    constructor(readonly fiberId: FiberId) {
        super(`Fiber#${fiberId.id} was interrupted`);
        this.name = "InterruptedException";
    }
}

/**
 * Utility to combine two FiberExits.
 */
export function combineFiberExits<E, A, B>(left: FiberExit<E, A>, right: FiberExit<E, B>): FiberExit<E, [A, B]> {
    if (isFiberSuccess(left) && isFiberSuccess(right)) {
        return fiberSuccess([left.value, right.value]);
    } else if (isFiberFailure(left) && isFiberFailure(right)) {
        return fiberFailure(both(left.cause, right.cause));
    } else if (isFiberFailure(left)) {
        return fiberFailure(left.cause);
    } else {
        return fiberFailure((right as { cause: Cause<E> }).cause);
    }
}
