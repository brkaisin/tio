import { TIO, TIOOp, TIOOpTag } from "./tio";
import { Either, left, right } from "./util/either";
import { identity, isNever } from "./util/functions";
import { Has, Tag } from "./tag";
import { Exit, failure, success } from "./util/exit";
import { FiberContext, fiberFailure, fiberSuccess, InterruptedException } from "./fiber";
import { fail as causeFail, interrupt as causeInterrupt } from "./cause";

/**
 * Interface for TIO runtime interpreters.
 *
 * A Runtime interprets the TIO ADT and executes the described effects.
 * Different implementations can provide different execution strategies.
 */
export interface Runtime<R> {
    unsafeRun<E, A>(tio: TIO<R, E, A>): Promise<A>;
    safeRunEither<E, A>(tio: TIO<R, E, A>): Promise<Either<E, A>>;
    safeRunExit<E, A>(tio: TIO<R, E, A>): Promise<Exit<E, A>>;
    safeRunUnion<E, A>(tio: TIO<R, E, A>): Promise<E | A>;
    provideService<Id extends string, S>(tag: Tag<Id, S>, service: S): Runtime<R & Has<Tag<Id, S>>>;
}

/**
 * Promise-based Runtime implementation.
 *
 * This runtime interprets the TIO ADT using JavaScript Promises.
 * Alternative implementations could use:
 * - Synchronous execution for testing
 * - Fibers for cooperative multitasking
 * - Web Workers for true parallelism
 * - Custom schedulers for specific use cases
 */
class PromiseRuntime<in R> implements Runtime<R> {
    constructor(private readonly services: Record<string, unknown>) {}

    private interpret<E, A>(tio: TIO<R, E, A>): Promise<A> {
        const op: TIOOp<R, E, A> = tio["op"];
        const r = this.services as R;

        switch (op._tag) {
            case TIOOpTag.Succeed:
                return Promise.resolve(op.value);

            case TIOOpTag.Fail:
                return Promise.reject(op.error);

            case TIOOpTag.Sync:
                try {
                    return Promise.resolve(op.f(r));
                } catch (e) {
                    return Promise.reject(e);
                }

            case TIOOpTag.Async:
                return new Promise<A>((resolve, reject) => {
                    op.register(r, resolve, reject);
                });

            case TIOOpTag.FlatMap:
                return op.run((tio, f) => this.interpret(tio).then((z) => this.interpret(f(z))));

            case TIOOpTag.FoldM:
                return op.run((tio, onError, onSuccess) =>
                    this.interpret(tio).then(
                        (a1) => this.interpret(onSuccess(a1)),
                        (e1) => this.interpret(onError(e1))
                    )
                );

            // Note: Due to JavaScript's single-threaded nature, synchronous operations
            // cannot be truly "raced" - they run to completion before any other code executes.
            // This works correctly for async operations (e.g., setTimeout, fetch),
            // but synchronous CPU-bound tasks will complete in the order they are started.
            case TIOOpTag.Race:
                return Promise.race(op.tios.map((t) => this.interpret(t)));

            case TIOOpTag.All:
                return op.run((tios) => Promise.all(tios.map((t) => this.interpret(t)))) as Promise<A>;

            case TIOOpTag.Ensuring:
                return op.run((tio, finalizer) =>
                    this.interpret(tio)
                        .then((a) => this.interpret(finalizer).then(() => a))
                        .catch((e) => this.interpret(finalizer).then(() => Promise.reject(e)))
                );

            case TIOOpTag.Sleep:
                return new Promise<A>((resolve) => setTimeout(() => resolve(undefined as A), op.ms));

            case TIOOpTag.Fork: {
                return op.run((tioToFork) => {
                    const childFiber = new FiberContext<unknown, unknown>();

                    queueMicrotask(() => {
                        this.interpret(tioToFork as TIO<R, unknown, unknown>)
                            .then((value) => childFiber.done(fiberSuccess(value)))
                            .catch((error) => {
                                if (error instanceof InterruptedException) {
                                    childFiber.done(fiberFailure(causeInterrupt(error.fiberId)));
                                } else {
                                    childFiber.done(fiberFailure(causeFail(error)));
                                }
                            });
                    });

                    return Promise.resolve(childFiber);
                }) as Promise<A>;
            }

            case TIOOpTag.SetInterruptible:
                // In the basic runtime, just execute the inner effect
                return this.interpret(op.tio);

            case TIOOpTag.CheckInterrupt:
                // In the basic runtime, never interrupted
                return Promise.resolve(undefined as A);

            default:
                isNever(op);
        }
    }

    unsafeRun<E, A>(tio: TIO<R, E, A>): Promise<A> {
        return this.interpret(tio);
    }

    safeRunEither<E, A>(tio: TIO<R, E, A>): Promise<Either<E, A>> {
        return this.interpret(tio).then(right).catch(left);
    }

    safeRunExit<E, A>(tio: TIO<R, E, A>): Promise<Exit<E, A>> {
        return this.interpret(tio).then(success).catch(failure);
    }

    safeRunUnion<E, A>(tio: TIO<R, E, A>): Promise<E | A> {
        return this.interpret(tio).catch(identity);
    }

    provideService<Id extends string, S>(tag: Tag<Id, S>, service: S): Runtime<R & Has<Tag<Id, S>>> {
        return new PromiseRuntime({
            ...this.services,
            [tag.id]: service
        });
    }
}

const defaultRuntime: Runtime<unknown> = new PromiseRuntime({});

export const Runtime = {
    get default(): Runtime<unknown> {
        return defaultRuntime;
    },

    withServices<R>(services: R): Runtime<R> {
        return new PromiseRuntime(services as Record<string, unknown>);
    }
};
