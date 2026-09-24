import { Canceler, TIO, TIOOp, TIOOpTag } from "./tio";
import { Either, fold, isLeft, left, right } from "./util/either";
import { identity, isNever } from "./util/functions";
import { Has, Tag } from "./tag";
import { Exit, failure, success } from "./util/exit";
import {
    Fiber,
    FiberExit,
    fiberFailure,
    FiberStatus,
    FiberStatusTag,
    fiberSuccess,
    InterruptedException,
    isFiberSuccess
} from "./fiber";
import { Cause, defects, die, failures, interrupt, interruptors, isInterrupted, makeFiberId } from "./cause";

/**
 * Interface for TIO runtime interpreters.
 *
 * A Runtime interprets the TIO ADT and executes the described effects.
 * Different implementations can provide different execution strategies.
 */
export interface Runtime<R> {
    /** Starts running the effect in a new fiber, and returns it (e.g. to interrupt it from outside). */
    unsafeRunFiber<E, A>(tio: TIO<R, E, A>): Fiber<E, A>;
    unsafeRun<E, A>(tio: TIO<R, E, A>): Promise<A>;
    safeRunEither<E, A>(tio: TIO<R, E, A>): Promise<Either<E, A>>;
    safeRunExit<E, A>(tio: TIO<R, E, A>): Promise<Exit<E, A>>;
    safeRunUnion<E, A>(tio: TIO<R, E, A>): Promise<E | A>;
    provideService<Id extends string, S>(tag: Tag<Id, S>, service: S): Runtime<R & Has<Tag<Id, S>>>;
}

type AnyTIO = TIO<any, any, any>;

const enum FrameTag {
    FlatMap = "FlatMap",
    Fold = "Fold",
    RestoreInterruptible = "RestoreInterruptible"
}

/** A continuation on the fiber's stack, waiting for the result of the current effect. */
type Frame =
    | { _tag: FrameTag.FlatMap; f: (a: unknown) => AnyTIO }
    | { _tag: FrameTag.Fold; onFailure: (cause: Cause<unknown>) => AnyTIO; onSuccess: (a: unknown) => AnyTIO }
    | { _tag: FrameTag.RestoreInterruptible; interruptible: boolean };

/** Number of steps a fiber runs before yielding to the event loop, so that other fibers and timers can run. */
const MAX_STEPS_BEFORE_YIELD = 2048;

/**
 * A fiber interpreting a TIO step by step, with an explicit stack of continuations.
 *
 * - Synchronous steps run in a loop (stack-safe), and the fiber suspends on async operations.
 * - Interruption is checked before each step: an interrupted fiber in an interruptible region
 *   stops what it's doing and unwinds its stack as a failure with an Interrupt cause
 *   (so that finalizers registered with `ensuring` run).
 * - If the fiber is suspended on an async operation when interrupted, the operation is cancelled
 *   (using its Canceler, if any) and the fiber resumes immediately.
 */
class FiberRuntime<E, A> implements Fiber<E, A> {
    readonly id = makeFiberId();
    private status: FiberStatus<E, A> = { _tag: FiberStatusTag.Running };
    private observers: Array<(exit: FiberExit<E, A>) => void> = [];
    private readonly stack: Array<Frame> = [];
    private interrupted = false;
    private interruptible = true;
    /** Defined while suspended on an async operation: cancels it and resumes the fiber as interrupted. */
    private interruptAsync: (() => void) | undefined = undefined;

    constructor(private readonly env: unknown) {}

    unsafeAddObserver(callback: (exit: FiberExit<E, A>) => void): () => void {
        if (this.status._tag === FiberStatusTag.Done) {
            callback(this.status.exit);
            return () => {};
        }
        this.observers.push(callback);
        return () => {
            this.observers = this.observers.filter((observer) => observer !== callback);
        };
    }

    unsafeInterrupt(): void {
        if (this.interrupted || this.status._tag === FiberStatusTag.Done) return;
        this.interrupted = true;
        // Otherwise, the interruption is picked up by the run loop (now, or when leaving the uninterruptible region)
        if (this.interruptible) this.interruptAsync?.();
    }

    unsafeStatus(): FiberStatus<E, A> {
        return this.status;
    }

    runLoop(start: AnyTIO): void {
        this.status = { _tag: FiberStatusTag.Running };
        let current: AnyTIO | undefined = start;
        for (let steps = 0; current !== undefined; steps++) {
            if (steps === MAX_STEPS_BEFORE_YIELD) {
                const next = current;
                setTimeout(() => this.runLoop(next), 0);
                return;
            }
            if (this.shouldInterrupt(current)) current = TIO.failCause(interrupt(this.id));
            try {
                current = this.step(current);
            } catch (e) {
                current = TIO.failCause(die(e));
            }
        }
    }

    /** Runs one step, returning the next effect to run, or undefined if the fiber is suspended or done. */
    private step(tio: AnyTIO): AnyTIO | undefined {
        const op: TIOOp<unknown, unknown, unknown> = tio["op"];
        switch (op._tag) {
            case TIOOpTag.Succeed:
                return this.onSuccess(op.value);

            case TIOOpTag.FailCause:
                return this.onFailure(op.cause);

            case TIOOpTag.Sync:
                return this.onSuccess(op.f(this.env));

            case TIOOpTag.Async:
                return this.suspend(op.register);

            case TIOOpTag.FlatMap:
                return op.run((tio, f) => {
                    this.stack.push({ _tag: FrameTag.FlatMap, f: f as (a: unknown) => AnyTIO });
                    return tio;
                });

            case TIOOpTag.FoldCauseM:
                return op.run((tio, onFailure, onSuccess) => {
                    this.stack.push({
                        _tag: FrameTag.Fold,
                        onFailure: onFailure as (cause: Cause<unknown>) => AnyTIO,
                        onSuccess: onSuccess as (a: unknown) => AnyTIO
                    });
                    return tio;
                });

            case TIOOpTag.Fork:
                return op.run((tio) => {
                    const child = new FiberRuntime(this.env);
                    queueMicrotask(() => child.runLoop(tio));
                    return TIO.succeed(child);
                });

            case TIOOpTag.SetInterruptible: {
                const previous = this.interruptible;
                this.stack.push({ _tag: FrameTag.RestoreInterruptible, interruptible: previous });
                this.interruptible = op.interruptible;
                return op.run(previous);
            }

            default:
                isNever(op);
        }
    }

    private onSuccess(value: unknown): AnyTIO | undefined {
        let frame: Frame | undefined;
        while ((frame = this.stack.pop()) !== undefined) {
            switch (frame._tag) {
                case FrameTag.FlatMap:
                    return frame.f(value);
                case FrameTag.Fold:
                    return frame.onSuccess(value);
                case FrameTag.RestoreInterruptible:
                    this.interruptible = frame.interruptible;
            }
        }
        this.done(fiberSuccess(value as A));
    }

    private onFailure(cause: Cause<unknown>): AnyTIO | undefined {
        let frame: Frame | undefined;
        while ((frame = this.stack.pop()) !== undefined) {
            switch (frame._tag) {
                case FrameTag.FlatMap:
                    break;
                case FrameTag.Fold:
                    return frame.onFailure(cause);
                case FrameTag.RestoreInterruptible:
                    this.interruptible = frame.interruptible;
            }
        }
        this.done(fiberFailure(cause as Cause<E>));
    }

    private suspend(
        register: (r: unknown, resolve: (a: unknown) => void, reject: (e: unknown) => void) => Canceler | void
    ): AnyTIO | undefined {
        let resumed = false;
        let registering = true;
        let next: AnyTIO | undefined = undefined;
        const resume = (tio: AnyTIO) => {
            if (resumed) return;
            resumed = true;
            this.interruptAsync = undefined;
            // If the callback is called synchronously by `register`, the current run loop continues with it
            if (registering) next = tio;
            else this.runLoop(tio);
        };

        let canceler: Canceler | void;
        try {
            canceler = register(
                this.env,
                (a) => resume(TIO.succeed(a)),
                (e) => resume(TIO.fail(e))
            );
        } catch (e) {
            resumed = true;
            throw e;
        }
        registering = false;
        if (resumed) return next;

        const cancel = () => {
            canceler?.();
            resume(TIO.failCause(interrupt(this.id)));
        };
        // The fiber might have been interrupted by `register` itself
        if (this.interrupted && this.interruptible) {
            registering = true;
            cancel();
            return next;
        }
        this.status = { _tag: FiberStatusTag.Suspended };
        this.interruptAsync = cancel;
    }

    private shouldInterrupt(current: AnyTIO): boolean {
        if (!this.interrupted || !this.interruptible) return false;
        // Don't replace a failure that is already propagating the interruption
        const op: TIOOp<unknown, unknown, unknown> = current["op"];
        return op._tag !== TIOOpTag.FailCause || !isInterrupted(op.cause);
    }

    private done(exit: FiberExit<E, A>): void {
        this.status = { _tag: FiberStatusTag.Done, exit };
        const observers = this.observers;
        this.observers = [];
        observers.forEach((observer) => observer(exit));
    }
}

/**
 * Converts the exit of a fiber to an Either. Defects and interruptions are not part of the
 * error type E, so they are thrown (rejecting the Promise returned by the Runtime).
 */
function exitToEither<E, A>(exit: FiberExit<E, A>): Either<E, A> {
    if (isFiberSuccess(exit)) return right(exit.value);
    const errors = failures(exit.cause);
    if (errors.length > 0) return left(errors[0]);
    const unexpected = defects(exit.cause);
    if (unexpected.length > 0) throw unexpected[0];
    throw new InterruptedException(interruptors(exit.cause)[0]);
}

/**
 * Fiber-based Runtime implementation.
 *
 * Each run starts a root fiber. Results are exposed as Promises: typed failures (E) are returned
 * or rejected depending on the method, while defects and interruptions always reject the Promise.
 */
class FiberBasedRuntime<in R> implements Runtime<R> {
    constructor(private readonly services: Record<string, unknown>) {}

    unsafeRunFiber<E, A>(tio: TIO<R, E, A>): Fiber<E, A> {
        const fiber = new FiberRuntime<E, A>(this.services);
        fiber.runLoop(tio);
        return fiber;
    }

    unsafeRun<E, A>(tio: TIO<R, E, A>): Promise<A> {
        return this.safeRunEither(tio).then((either) =>
            fold(
                either,
                (e) => {
                    throw e;
                },
                identity
            )
        );
    }

    safeRunEither<E, A>(tio: TIO<R, E, A>): Promise<Either<E, A>> {
        return new Promise<FiberExit<E, A>>((resolve) => this.unsafeRunFiber(tio).unsafeAddObserver(resolve)).then(
            exitToEither
        );
    }

    safeRunExit<E, A>(tio: TIO<R, E, A>): Promise<Exit<E, A>> {
        return this.safeRunEither(tio).then((either) =>
            isLeft(either) ? failure(either.left) : success(either.right)
        );
    }

    safeRunUnion<E, A>(tio: TIO<R, E, A>): Promise<E | A> {
        return this.safeRunEither(tio).then((either) => (isLeft(either) ? either.left : either.right));
    }

    provideService<Id extends string, S>(tag: Tag<Id, S>, service: S): Runtime<R & Has<Tag<Id, S>>> {
        return new FiberBasedRuntime({
            ...this.services,
            [tag.id]: service
        });
    }
}

const defaultRuntime: Runtime<unknown> = new FiberBasedRuntime({});

export const Runtime = {
    get default(): Runtime<unknown> {
        return defaultRuntime;
    },

    withServices<R>(services: R): Runtime<R> {
        return new FiberBasedRuntime(services as Record<string, unknown>);
    }
};
