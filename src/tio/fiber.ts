import { Cause, FiberId, makeFiberId, interrupt as causeInterrupt, both } from "./cause";

/**
 * FiberStatus represents the current state of a Fiber.
 */
export type FiberStatus<E, A> =
    | { readonly _tag: "Running" }
    | { readonly _tag: "Suspended" }
    | { readonly _tag: "Done"; readonly exit: FiberExit<E, A> };

/**
 * FiberExit is the result of a Fiber completing.
 * Unlike Exit, it uses Cause for richer failure information.
 */
export type FiberExit<E, A> =
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly cause: Cause<E> };

export function fiberSuccess<E, A>(value: A): FiberExit<E, A> {
    return { _tag: "Success", value };
}

export function fiberFailure<E, A>(cause: Cause<E>): FiberExit<E, A> {
    return { _tag: "Failure", cause };
}

export function isFiberSuccess<E, A>(exit: FiberExit<E, A>): exit is { readonly _tag: "Success"; readonly value: A } {
    return exit._tag === "Success";
}

export function isFiberFailure<E, A>(
    exit: FiberExit<E, A>
): exit is { readonly _tag: "Failure"; readonly cause: Cause<E> } {
    return exit._tag === "Failure";
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
    private _status: FiberStatus<E, A>;
    private _observers: Array<(exit: FiberExit<E, A>) => void>;
    private _interrupted: boolean;
    private _interruptible: boolean;

    constructor() {
        this.id = makeFiberId();
        this._status = { _tag: "Running" };
        this._observers = [];
        this._interrupted = false;
        this._interruptible = true;
    }

    done(exit: FiberExit<E, A>): void {
        if (this._status._tag === "Done") return;
        this._status = { _tag: "Done", exit };
        const observers = this._observers;
        this._observers = [];
        for (const observer of observers) {
            observer(exit);
        }
    }

    unsafeAddObserver(callback: (exit: FiberExit<E, A>) => void): () => void {
        if (this._status._tag === "Done") {
            callback(this._status.exit);
            return () => {};
        }
        this._observers.push(callback);
        return () => {
            const idx = this._observers.indexOf(callback);
            if (idx >= 0) this._observers.splice(idx, 1);
        };
    }

    unsafeInterrupt(): void {
        if (this._interrupted) return;
        this._interrupted = true;
        if (this._interruptible && this._status._tag !== "Done") {
            this.done(fiberFailure(causeInterrupt(this.id)));
        }
    }

    unsafeStatus(): FiberStatus<E, A> {
        return this._status;
    }
}

/**
 * Exception thrown when a fiber is interrupted.
 */
export class InterruptedException extends Error {
    readonly _tag = "InterruptedException";
    constructor(readonly fiberId: FiberId) {
        super(`Fiber#${fiberId.id} was interrupted`);
        this.name = "InterruptedException";
    }
}

/**
 * Utility to combine two FiberExits.
 */
export function combineFiberExits<E, A, B>(left: FiberExit<E, A>, right: FiberExit<E, B>): FiberExit<E, [A, B]> {
    if (left._tag === "Success" && right._tag === "Success") {
        return fiberSuccess([left.value, right.value]);
    } else if (left._tag === "Failure" && right._tag === "Failure") {
        return fiberFailure(both(left.cause, right.cause));
    } else if (left._tag === "Failure") {
        return fiberFailure(left.cause);
    } else {
        return fiberFailure((right as { cause: Cause<E> }).cause);
    }
}
