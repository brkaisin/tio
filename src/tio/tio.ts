import { identity } from "./util/functions";
import { IO, UIO, URIO } from "./aliases";
import { Either, fold } from "./util/either";

// Internal operation types for the TIO ADT
export type TIOOp<R, E, A> =
    | { _tag: "Succeed"; value: A }
    | { _tag: "Fail"; error: E }
    | { _tag: "Sync"; f: (r: R) => A }
    | { _tag: "Async"; register: (r: R, resolve: (a: A) => void, reject: (e: E) => void) => void }
    | { _tag: "FlatMap"; run: <B>(cont: <A1>(tio: TIO<R, E, A1>, f: (a1: A1) => TIO<R, E, A>) => B) => B }
    | { _tag: "FoldM"; run: <B>(cont: <A1, E1>(tio: TIO<R, E1, A1>, onError: (e1: E1) => TIO<R, E, A>, onSuccess: (a1: A1) => TIO<R, E, A>) => B) => B }
    | { _tag: "Race"; tios: Array<TIO<R, E, A>> }
    | { _tag: "All"; run: <B>(cont: <A1>(tios: Array<TIO<R, E, A1>>) => B) => B }
    | { _tag: "Ensuring"; run: <B>(cont: <E1>(tio: TIO<R, E1, A>, finalizer: TIO<R, never, unknown>) => B) => B }
    | { _tag: "Sleep"; ms: number };

export class TIO<in R, out E, out A> {
    /** @internal */
    private constructor(protected readonly op: TIOOp<R, E, A>) {}

    map<B>(f: (a: A) => B): TIO<R, E, B> {
        return this.flatMap(a => TIO.succeed(f(a)));
    }

    mapError<E1>(f: (e: E) => E1): TIO<R, E1, A> {
        return this.foldM(
            e => TIO.fail(f(e)),
            a => TIO.succeed(a)
        );
    }

    mapBoth<E1, B>(f: (e: E) => E1, g: (a: A) => B): TIO<R, E1, B> {
        return this.map(g).mapError(f);
    }

    flatMap<R1, E1, B>(f: (a: A) => TIO<R1, E1, B>): TIO<R & R1, E | E1, B> {
        return new TIO<R & R1, E | E1, B>({
            _tag: "FlatMap",
            run: <C>(cont: <A1>(tio: TIO<R & R1, E | E1, A1>, f: (a1: A1) => TIO<R & R1, E | E1, B>) => C) =>
                cont(this, f)
        });
    }

    flatMapError<E1>(f: (e: E) => TIO<R, never, E1>): TIO<R, E1, A> {
        return this.flipWith(tio => tio.flatMap(f));
    }

    orElse<R1, E1, B>(that: TIO<R1, E1, B>): TIO<R & R1, E1, A | B> {
        return this.foldM<R1, E1, A | B>(
            () => that,
            a => TIO.succeed(a)
        );
    }

    tap<R1, E1>(f: (a: A) => TIO<R1, E1, unknown>): TIO<R & R1, E | E1, A> {
        return this.flatMap(a => f(a).map(() => a));
    }

    tapError<R1, E1>(f: (e: E) => TIO<R1, E1, unknown>): TIO<R & R1, E | E1, A> {
        return this.foldM(
            e => f(e).flatMap(() => TIO.fail(e)),
            a => TIO.succeed(a)
        );
    }

    tapBoth<R1, E1>(f: (a: A) => TIO<R1, E1, unknown>, g: (e: E) => TIO<R1, E1, unknown>): TIO<R & R1, E | E1, A> {
        return this.tap(f).tapError(g as (e: E | E1) => TIO<R1, E1, unknown>);
    }

    flip(): TIO<R, A, E> {
        return this.foldM(
            (e: E) => TIO.succeed(e),
            (a: A) => TIO.fail(a)
        );
    }

    flipWith<R1, A1, E1>(f: (flipped: TIO<R, A, E>) => TIO<R1, A1, E1>): TIO<R1, E1, A1> {
        return f(this.flip()).flip();
    }

    foldM<R1, E1, B>(onError: (e: E) => TIO<R1, E1, B>, onSuccess: (a: A) => TIO<R1, E1, B>): TIO<R & R1, E1, B> {
        return new TIO<R & R1, E1, B>({
            _tag: "FoldM",
            run: <C>(cont: <A1, E2>(tio: TIO<R & R1, E2, A1>, onErr: (e: E2) => TIO<R & R1, E1, B>, onSucc: (a1: A1) => TIO<R & R1, E1, B>) => C) =>
                cont(this, onError, onSuccess)
        });
    }

    fold<B>(onError: (e: E) => B, onSuccess: (a: A) => B): URIO<R, B> {
        return this.foldM(
            (e) => TIO.succeed(onError(e)),
            (a) => TIO.succeed(onSuccess(a))
        );
    }

    augmentError<E1>(this: E extends E1 ? TIO<R, E, A> : never): TIO<R, E1, A> {
        return this.mapError(identity);
    }

    absolve<E1, B>(this: TIO<R, E, Either<E1, B>>): TIO<R, E | E1, B> {
        return this.flatMap(TIO.fromEither);
    }

    zip<R1, B>(that: TIO<R1, E, B>): TIO<R & R1, E, [A, B]> {
        return TIO.all<R & R1, E, A | B>(this, that).map(([a, b]) => [a, b] as [A, B]);
    }

    zipLeft<R1, B>(that: TIO<R1, E, B>): TIO<R & R1, E, A> {
        return this.zip(that).map(([a, _]) => a);
    }

    zipRight<R1, B>(that: TIO<R1, E, B>): TIO<R & R1, E, B> {
        return this.zip(that).map(([_, b]) => b);
    }

    zipWith<R1, B, C>(that: TIO<R1, E, B>, f: (a: A, b: B) => C): TIO<R & R1, E, C> {
        return this.zip(that).map(([a, b]) => f(a, b));
    }

    as<B>(b: B): TIO<R, E, B> {
        return this.map(() => b);
    }

    unit(): TIO<R, E, void> {
        return this.as(undefined);
    }

    delay(ms: number): TIO<R, E, A> {
        return TIO.sleep(ms).flatMap(() => this);
    }

    ensuring<R1>(finalizer: TIO<R1, never, unknown>): TIO<R & R1, E, A> {
        return new TIO<R & R1, E, A>({
            _tag: "Ensuring",
            run: <B>(cont: <E1>(tio: TIO<R & R1, E1, A>, fin: TIO<R & R1, never, unknown>) => B) =>
                cont(this, finalizer)
        });
    }

    retry(n: number): TIO<R, E, A> {
        if (n <= 0) return this;
        return this.orElse(this.retry(n - 1));
    }

    // Note: Due to JavaScript's single-threaded nature, synchronous operations inside Promise
    // executors cannot be truly "raced" - they run to completion before any other code executes.
    // This race implementation works correctly for async operations (e.g., setTimeout, fetch),
    // but synchronous CPU-bound tasks will complete in the order they are started.
    // True parallelism for synchronous operations would require Worker Threads.
    race<R1, E1, B>(...tios: Array<TIO<R1, E1, B>>): TIO<R & R1, E | E1, A | B> {
        return TIO.race<R & R1, E | E1, A | B>(this, ...tios);
    }

    timeout(ms: number): TIO<R, E, A | null> {
        return this.race(TIO.sleep(ms).as(null));
    }

    static make<R, A>(f: (r: R) => A): TIO<R, never, A> {
        return new TIO<R, never, A>({ _tag: "Sync", f });
    }

    static flatten<R, E, A>(tio: TIO<R, E, TIO<R, E, A>>): TIO<R, E, A> {
        return tio.flatMap(identity);
    }

    static async<R, E, A>(register: (r: R, resolve: (a: A) => void, reject: (e: E) => void) => void): TIO<R, E, A> {
        return new TIO<R, E, A>({ _tag: "Async", register });
    }

    static fromPromise<E, A>(promise: () => Promise<A>, onError: (e: E) => E = identity<E>): IO<E, A> {
        return TIO.async<void, E, A>((_, resolve, reject) => {
            promise().then(resolve).catch(e => reject(onError(e)));
        });
    }

    static fromEither<E, A>(either: Either<E, A>): IO<E, A> {
        return fold<E, A, IO<E, A>>(either, TIO.fail<E>, TIO.succeed<A>);
    }

    static succeed<A>(a: A): UIO<A> {
        return new TIO<void, never, A>({ _tag: "Succeed", value: a });
    }

    static fail<E>(e: E): IO<E, never> {
        return new TIO<void, E, never>({ _tag: "Fail", error: e });
    }

    static race<R, E, A>(...tios: Array<TIO<R, E, A>>): TIO<R, E, A> {
        return new TIO<R, E, A>({ _tag: "Race", tios });
    }

    static all<R, E, A>(...tios: Array<TIO<R, E, A>>): TIO<R, E, Array<A>> {
        return new TIO<R, E, Array<A>>({
            _tag: "All",
            run: <B>(cont: <A1>(tios: Array<TIO<R, E, A1>>) => B) => cont(tios)
        });
    }

    static sleep(ms: number): UIO<void> {
        return new TIO<void, never, void>({ _tag: "Sleep", ms });
    }
}
