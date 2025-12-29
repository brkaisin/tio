import { identity } from "./util/functions";
import { IO, UIO, URIO } from "./aliases";
import { Either, fold } from "./util/either";

/**
 * TIO ADT operations.
 * `cont` = continuation, used for type-safe existential encoding via CPS
 */
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

/**
 * TIO is a purely functional effect type that describes effectful computations.
 *
 * TIO is lazy - it describes what to do, but doesn't execute until run by a Runtime.
 * This enables referential transparency and composability of side effects.
 *
 * @template R - The environment/dependencies required to run the effect
 * @template E - The type of errors the effect can fail with
 * @template A - The type of the success value
 *
 * @example
 * ```ts
 * // Create effects
 * const succeed = TIO.succeed(42);
 * const fail = TIO.fail("error");
 * const async = TIO.fromPromise(() => fetch("/api"));
 *
 * // Compose effects
 * const program = succeed
 *   .map(n => n * 2)
 *   .flatMap(n => TIO.succeed(n.toString()))
 *   .tap(s => TIO.succeed(console.log(s)));
 *
 * // Run with a Runtime
 * await Runtime.default.unsafeRun(program);
 * ```
 */
export class TIO<in R, out E, out A> {
    /** @internal */
    private constructor(protected readonly op: TIOOp<R, E, A>) {}

    /** Transforms the success value using the given function. */
    map<B>(f: (a: A) => B): TIO<R, E, B> {
        return this.flatMap(a => TIO.succeed(f(a)));
    }

    /** Transforms the error value using the given function. */
    mapError<E1>(f: (e: E) => E1): TIO<R, E1, A> {
        return this.foldM(
            e => TIO.fail(f(e)),
            a => TIO.succeed(a)
        );
    }

    /** Transforms both the error and success values. */
    mapBoth<E1, B>(f: (e: E) => E1, g: (a: A) => B): TIO<R, E1, B> {
        return this.map(g).mapError(f);
    }

    /** Chains this effect with another effect that depends on the success value. */
    flatMap<R1, E1, B>(f: (a: A) => TIO<R1, E1, B>): TIO<R & R1, E | E1, B> {
        return new TIO<R & R1, E | E1, B>({
            _tag: "FlatMap",
            run: <C>(cont: <A1>(tio: TIO<R & R1, E | E1, A1>, f: (a1: A1) => TIO<R & R1, E | E1, B>) => C) =>
                cont(this, f)
        });
    }

    /** Chains this effect's error with another effect. */
    flatMapError<E1>(f: (e: E) => TIO<R, never, E1>): TIO<R, E1, A> {
        return this.flipWith(tio => tio.flatMap(f));
    }

    /** Returns this effect if it succeeds, otherwise returns the given effect. */
    orElse<R1, E1, B>(that: TIO<R1, E1, B>): TIO<R & R1, E1, A | B> {
        return this.foldM<R1, E1, A | B>(
            () => that,
            a => TIO.succeed(a)
        );
    }

    /** Executes a side effect on success, returning the original value. */
    tap<R1, E1>(f: (a: A) => TIO<R1, E1, unknown>): TIO<R & R1, E | E1, A> {
        return this.flatMap(a => f(a).map(() => a));
    }

    /** Executes a side effect on error, returning the original error. */
    tapError<R1, E1>(f: (e: E) => TIO<R1, E1, unknown>): TIO<R & R1, E | E1, A> {
        return this.foldM(
            e => f(e).flatMap(() => TIO.fail(e)),
            a => TIO.succeed(a)
        );
    }

    /** Executes side effects on both success and error. */
    tapBoth<R1, E1>(f: (a: A) => TIO<R1, E1, unknown>, g: (e: E) => TIO<R1, E1, unknown>): TIO<R & R1, E | E1, A> {
        return this.tap(f).tapError(g as (e: E | E1) => TIO<R1, E1, unknown>);
    }

    /** Swaps the error and success channels. */
    flip(): TIO<R, A, E> {
        return this.foldM(
            (e: E) => TIO.succeed(e),
            (a: A) => TIO.fail(a)
        );
    }

    /** Applies a function to the flipped effect, then flips back. */
    flipWith<R1, A1, E1>(f: (flipped: TIO<R, A, E>) => TIO<R1, A1, E1>): TIO<R1, E1, A1> {
        return f(this.flip()).flip();
    }

    /** Handles both success and error cases with effects. */
    foldM<R1, E1, B>(onError: (e: E) => TIO<R1, E1, B>, onSuccess: (a: A) => TIO<R1, E1, B>): TIO<R & R1, E1, B> {
        return new TIO<R & R1, E1, B>({
            _tag: "FoldM",
            run: <C>(cont: <A1, E2>(tio: TIO<R & R1, E2, A1>, onErr: (e: E2) => TIO<R & R1, E1, B>, onSucc: (a1: A1) => TIO<R & R1, E1, B>) => C) =>
                cont(this, onError, onSuccess)
        });
    }

    /** Handles both success and error cases with pure functions. */
    fold<B>(onError: (e: E) => B, onSuccess: (a: A) => B): URIO<R, B> {
        return this.foldM(
            (e) => TIO.succeed(onError(e)),
            (a) => TIO.succeed(onSuccess(a))
        );
    }

    /** Widens the error type (useful for type inference). */
    augmentError<E1>(this: E extends E1 ? TIO<R, E, A> : never): TIO<R, E1, A> {
        return this.mapError(identity);
    }

    /** Unwraps an Either from the success channel into the error/success channels. */
    absolve<E1, B>(this: TIO<R, E, Either<E1, B>>): TIO<R, E | E1, B> {
        return this.flatMap(TIO.fromEither);
    }

    /** Combines this effect with another, returning both results as a tuple. */
    zip<R1, B>(that: TIO<R1, E, B>): TIO<R & R1, E, [A, B]> {
        return TIO.all<R & R1, E, A | B>(this, that).map(([a, b]) => [a, b] as [A, B]);
    }

    /** Combines with another effect, keeping only the left result. */
    zipLeft<R1, B>(that: TIO<R1, E, B>): TIO<R & R1, E, A> {
        return this.zip(that).map(([a, _]) => a);
    }

    /** Combines with another effect, keeping only the right result. */
    zipRight<R1, B>(that: TIO<R1, E, B>): TIO<R & R1, E, B> {
        return this.zip(that).map(([_, b]) => b);
    }

    /** Combines with another effect using a function to merge results. */
    zipWith<R1, B, C>(that: TIO<R1, E, B>, f: (a: A, b: B) => C): TIO<R & R1, E, C> {
        return this.zip(that).map(([a, b]) => f(a, b));
    }

    /** Replaces the success value with the given constant. */
    as<B>(b: B): TIO<R, E, B> {
        return this.map(() => b);
    }

    /** Discards the success value, returning void. */
    unit(): TIO<R, E, void> {
        return this.as(undefined);
    }

    /** Delays execution of this effect by the given milliseconds. */
    delay(ms: number): TIO<R, E, A> {
        return TIO.sleep(ms).flatMap(() => this);
    }

    /** Ensures a finalizer runs after this effect, regardless of success or failure. */
    ensuring<R1>(finalizer: TIO<R1, never, unknown>): TIO<R & R1, E, A> {
        return new TIO<R & R1, E, A>({
            _tag: "Ensuring",
            run: <B>(cont: <E1>(tio: TIO<R & R1, E1, A>, fin: TIO<R & R1, never, unknown>) => B) =>
                cont(this, finalizer)
        });
    }

    /** Retries this effect up to n times on failure. */
    retry(n: number): TIO<R, E, A> {
        if (n <= 0) return this;
        return this.orElse(this.retry(n - 1));
    }

    /** Races this effect against others, returning the first to complete. */
    race<R1, E1, B>(...tios: Array<TIO<R1, E1, B>>): TIO<R & R1, E | E1, A | B> {
        return TIO.race<R & R1, E | E1, A | B>(this, ...tios);
    }

    /** Returns the result if completed within the timeout, otherwise null. */
    timeout(ms: number): TIO<R, E, A | null> {
        return this.race(TIO.sleep(ms).as(null));
    }

    /** Creates an effect from a synchronous function that uses the environment. */
    static make<R, A>(f: (r: R) => A): TIO<R, never, A> {
        return new TIO<R, never, A>({ _tag: "Sync", f });
    }

    /** Flattens a nested TIO. */
    static flatten<R, E, A>(tio: TIO<R, E, TIO<R, E, A>>): TIO<R, E, A> {
        return tio.flatMap(identity);
    }

    /** Creates an effect from an async callback-based API. */
    static async<R, E, A>(register: (r: R, resolve: (a: A) => void, reject: (e: E) => void) => void): TIO<R, E, A> {
        return new TIO<R, E, A>({ _tag: "Async", register });
    }

    /** Creates an effect from a Promise. */
    static fromPromise<E, A>(promise: () => Promise<A>, onError: (e: E) => E = identity<E>): IO<E, A> {
        return TIO.async<void, E, A>((_, resolve, reject) => {
            promise().then(resolve).catch(e => reject(onError(e)));
        });
    }

    /** Creates an effect from an Either. */
    static fromEither<E, A>(either: Either<E, A>): IO<E, A> {
        return fold<E, A, IO<E, A>>(either, TIO.fail<E>, TIO.succeed<A>);
    }

    /** Creates an effect that succeeds with the given value. */
    static succeed<A>(a: A): UIO<A> {
        return new TIO<void, never, A>({ _tag: "Succeed", value: a });
    }

    /** Creates an effect that fails with the given error. */
    static fail<E>(e: E): IO<E, never> {
        return new TIO<void, E, never>({ _tag: "Fail", error: e });
    }

    /** Races multiple effects, returning the first to complete. */
    static race<R, E, A>(...tios: Array<TIO<R, E, A>>): TIO<R, E, A> {
        return new TIO<R, E, A>({ _tag: "Race", tios });
    }

    /** Runs multiple effects in parallel, collecting all results. */
    static all<R, E, A>(...tios: Array<TIO<R, E, A>>): TIO<R, E, Array<A>> {
        return new TIO<R, E, Array<A>>({
            _tag: "All",
            run: <B>(cont: <A1>(tios: Array<TIO<R, E, A1>>) => B) => cont(tios)
        });
    }

    /** Creates an effect that sleeps for the given milliseconds. */
    static sleep(ms: number): UIO<void> {
        return new TIO<void, never, void>({ _tag: "Sleep", ms });
    }
}
