import { TIO, TIOOp } from "./tio";
import { Either, left, right } from "./util/either";
import {identity, isNever} from "./util/functions";
import { Has, Tag } from "./tag";
import { Exit, failure, success } from "./util/exit";

export class Runtime<in R> {
    constructor(private readonly services: Record<string, unknown>) {}

    private interpret<E, A>(tio: TIO<R, E, A>): Promise<A> {
        const op: TIOOp<R, E, A> = tio['op'];
        const r = this.services as R;

        switch (op._tag) {
            case "Succeed":
                return Promise.resolve(op.value);

            case "Fail":
                return Promise.reject(op.error);

            case "Sync":
                try {
                    return Promise.resolve(op.f(r));
                } catch (e) {
                    return Promise.reject(e);
                }

            case "Async":
                return new Promise<A>((resolve, reject) => {
                    op.register(r, resolve, reject);
                });

            case "FlatMap":
                return op.run((tio, f) =>
                    this.interpret(tio).then(z => this.interpret(f(z)))
                );

            case "FoldM":
                return op.run((tio, onError, onSuccess) =>
                    this.interpret(tio).then(
                        a1 => this.interpret(onSuccess(a1)),
                        e1 => this.interpret(onError(e1))
                    )
                );

            // Note: Due to JavaScript's single-threaded nature, synchronous operations
            // cannot be truly "raced" - they run to completion before any other code executes.
            // This works correctly for async operations (e.g., setTimeout, fetch),
            // but synchronous CPU-bound tasks will complete in the order they are started.
            case "Race":
                return Promise.race(op.tios.map(t => this.interpret(t)));

            case "All":
                return op.run(tios =>
                    Promise.all(tios.map(t => this.interpret(t)))
                ) as Promise<A>;

            case "Ensuring":
                return op.run((tio, finalizer) =>
                    this.interpret(tio)
                        .then(a => this.interpret(finalizer).then(() => a))
                        .catch(e => this.interpret(finalizer).then(() => Promise.reject(e)))
                );

            case "Sleep":
                return new Promise<A>(resolve => setTimeout(() => resolve(undefined as A), op.ms));

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
        return new Runtime({
            ...this.services,
            [tag.id]: service,
        });
    }

    static default: Runtime<unknown> = new Runtime({});
}

