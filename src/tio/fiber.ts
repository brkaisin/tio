import { both, Cause, FiberId, interrupt as causeInterrupt, makeFiberId } from "./cause";

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
 */
export interface Fiber<E, A> {
    readonly id: FiberId;
    readonly unsafeAddObserver: (callback: (exit: FiberExit<E, A>) => void) => () => void;
    readonly unsafeInterrupt: () => void;
    readonly unsafeStatus: () => FiberStatus<E, A>;
}

/**
 * Internal mutable state for a running fiber.
 */
export class FiberContext<E, A> implements Fiber<E, A> {
    readonly id: FiberId;
    private status: FiberStatus<E, A>;
    private observers: Array<(exit: FiberExit<E, A>) => void>;
    private interrupted: boolean;
    private interruptible: boolean;

    constructor() {
        this.id = makeFiberId();
        this.status = { _tag: FiberStatusTag.Running };
        this.observers = [];
        this.interrupted = false;
        this.interruptible = true;
    }

    done(exit: FiberExit<E, A>): void {
        if (this.status._tag === FiberStatusTag.Done) return;
        this.status = { _tag: FiberStatusTag.Done, exit };
        const observers = this.observers;
        this.observers = [];
        for (const observer of observers) {
            observer(exit);
        }
    }

    unsafeAddObserver(callback: (exit: FiberExit<E, A>) => void): () => void {
        if (this.status._tag === FiberStatusTag.Done) {
            callback(this.status.exit);
            return () => {};
        }
        this.observers.push(callback);
        return () => {
            const idx = this.observers.indexOf(callback);
            if (idx >= 0) this.observers.splice(idx, 1);
        };
    }

    unsafeInterrupt(): void {
        if (this.interrupted) return;
        this.interrupted = true;
        if (this.interruptible && this.status._tag !== FiberStatusTag.Done) {
            this.done(fiberFailure(causeInterrupt(this.id)));
        }
    }

    unsafeStatus(): FiberStatus<E, A> {
        return this.status;
    }
}

/**
 * Exception thrown when a fiber is interrupted.
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
