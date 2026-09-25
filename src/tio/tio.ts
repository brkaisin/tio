import { identity } from "./util/functions";
import { IO, UIO, URIO } from "./aliases";
import { Either, fold } from "./util/either";
import { Fiber, FiberExit, fiberFailure, FiberStatus, fiberSuccess, isFiberSuccess } from "./fiber";
import { both, Cause, CauseTag, empty, fail, failures, isInterruptedOnly, sequential } from "./cause";

export const enum TIOOpTag {
    Succeed = "Succeed",
    FailCause = "FailCause",
    Sync = "Sync",
    Async = "Async",
    FlatMap = "FlatMap",
    FoldCauseM = "FoldCauseM",
    Fork = "Fork",
    SetInterruptible = "SetInterruptible"
}

/** Cancels a pending async operation. Called when the waiting fiber is interrupted. */
export type Canceler = () => void;

/**
 * TIO ADT operations.
 * `cont` = continuation, used for type-safe existential encoding via CPS
 */
export type TIOOp<R, E, A> =
    | { _tag: TIOOpTag.Succeed; value: A }
    | { _tag: TIOOpTag.FailCause; cause: Cause<E> }
    | { _tag: TIOOpTag.Sync; f: (r: R) => A }
    | {
          _tag: TIOOpTag.Async;
          register: (r: R, resolve: (a: A) => void, reject: (e: E) => void) => Canceler | void;
      }
    | { _tag: TIOOpTag.FlatMap; run: <B>(cont: <A1>(tio: TIO<R, E, A1>, f: (a1: A1) => TIO<R, E, A>) => B) => B }
    | {
          _tag: TIOOpTag.FoldCauseM;
          run: <B>(
              cont: <A1, E1>(
                  tio: TIO<R, E1, A1>,
                  onFailure: (cause: Cause<E1>) => TIO<R, E, A>,
                  onSuccess: (a1: A1) => TIO<R, E, A>
              ) => B
          ) => B;
      }
    | { _tag: TIOOpTag.Fork; run: <B>(cont: <E1, A1>(tio: TIO<R, E1, A1>) => B) => B }
    // `run` receives the interruptibility that was active before entering the region
    | { _tag: TIOOpTag.SetInterruptible; interruptible: boolean; run: (previous: boolean) => TIO<R, E, A> };

/** Restores the interruptibility of the enclosing region, see `TIO.uninterruptibleMask`. */
export type Restore = <R, E, A>(tio: TIO<R, E, A>) => TIO<R, E, A>;

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

/**
 * The environment required by a `TIO.gen` block: the intersection of the environments of all yielded effects.
 * `any` (e.g. from `IO`) and `unknown` environments require nothing: they are left out, so they don't erase
 * the others.
 */
export type GenR<Eff> = UnionToIntersection<
    Eff extends TIO<infer R, any, any> ? (unknown extends R ? never : R) : never
>;

/** The errors of a `TIO.gen` block: the union of the errors of all yielded effects. */
export type GenE<Eff> = Eff extends TIO<any, infer E, any> ? E : never;

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
        return this.flatMap((a) => TIO.succeed(f(a)));
    }

    /** Transforms the error value using the given function. */
    mapError<E1>(f: (e: E) => E1): TIO<R, E1, A> {
        return this.foldM(
            (e) => TIO.fail(f(e)),
            (a) => TIO.succeed(a)
        );
    }

    /** Transforms both the error and success values. */
    mapBoth<E1, B>(f: (e: E) => E1, g: (a: A) => B): TIO<R, E1, B> {
        return this.map(g).mapError(f);
    }

    /** Chains this effect with another effect that depends on the success value. */
    flatMap<R1, E1, B>(f: (a: A) => TIO<R1, E1, B>): TIO<R & R1, E | E1, B> {
        return new TIO<R & R1, E | E1, B>({
            _tag: TIOOpTag.FlatMap,
            run: <C>(cont: <A1>(tio: TIO<R & R1, E | E1, A1>, f: (a1: A1) => TIO<R & R1, E | E1, B>) => C) =>
                cont(this, f)
        });
    }

    /** Chains this effect's error with another effect. */
    flatMapError<E1>(f: (e: E) => TIO<R, never, E1>): TIO<R, E1, A> {
        return this.flipWith((tio) => tio.flatMap(f));
    }

    /** Returns this effect if it succeeds, otherwise returns the given effect. */
    orElse<R1, E1, B>(that: TIO<R1, E1, B>): TIO<R & R1, E1, A | B> {
        return this.foldM<R1, E1, A | B>(
            () => that,
            (a) => TIO.succeed(a)
        );
    }

    /** Executes a side effect on success, returning the original value. */
    tap<R1, E1>(f: (a: A) => TIO<R1, E1, unknown>): TIO<R & R1, E | E1, A> {
        return this.flatMap((a) => f(a).map(() => a));
    }

    /** Executes a side effect on error, returning the original error. */
    tapError<R1, E1>(f: (e: E) => TIO<R1, E1, unknown>): TIO<R & R1, E | E1, A> {
        return this.foldM(
            (e) => f(e).flatMap(() => TIO.fail(e)),
            (a) => TIO.succeed(a)
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

    /** Handles both success and error cases with effects. Defects and interruptions are not caught. */
    foldM<R1, E1, B>(onError: (e: E) => TIO<R1, E1, B>, onSuccess: (a: A) => TIO<R1, E1, B>): TIO<R & R1, E1, B> {
        return this.foldCauseM((cause) => {
            const errors = failures(cause);
            return errors.length > 0 ? onError(errors[0]) : TIO.failCause(cause as Cause<never>);
        }, onSuccess);
    }

    /** Handles both success and failure cases with effects, giving access to the full Cause of a failure. */
    foldCauseM<R1, E1, B>(
        onFailure: (cause: Cause<E>) => TIO<R1, E1, B>,
        onSuccess: (a: A) => TIO<R1, E1, B>
    ): TIO<R & R1, E1, B> {
        return new TIO<R & R1, E1, B>({
            _tag: TIOOpTag.FoldCauseM,
            run: <C>(
                cont: <A1, E2>(
                    tio: TIO<R & R1, E2, A1>,
                    onFail: (cause: Cause<E2>) => TIO<R & R1, E1, B>,
                    onSucc: (a1: A1) => TIO<R & R1, E1, B>
                ) => C
            ) => cont(this, onFailure, onSuccess)
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

    /**
     * Ensures a finalizer runs after this effect, whether it succeeds, fails or is interrupted.
     * The finalizer itself runs uninterruptibly.
     */
    ensuring<R1>(finalizer: TIO<R1, never, unknown>): TIO<R & R1, E, A> {
        return TIO.uninterruptibleMask((restore) =>
            restore(this).foldCauseM(
                (cause) =>
                    finalizer.foldCauseM(
                        (finalizerCause) => TIO.failCause(sequential<E>(cause, finalizerCause)),
                        () => TIO.failCause(cause)
                    ),
                (a) => finalizer.foldCauseM(TIO.failCause, () => TIO.succeed(a))
            )
        );
    }

    /** Retries this effect up to n times on failure. */
    retry(n: number): TIO<R, E, A> {
        if (n <= 0) return this;
        return this.orElse(this.retry(n - 1));
    }

    /** Races this effect against others, returning the first to complete. The losers are interrupted. */
    race<R1, E1, B>(...tios: Array<TIO<R1, E1, B>>): TIO<R & R1, E | E1, A | B> {
        return TIO.race<R & R1, E | E1, A | B>(this, ...tios);
    }

    /** Returns the result if completed within the timeout, otherwise null. The effect is interrupted on timeout. */
    timeout(ms: number): TIO<R, E, A | null> {
        return this.race(TIO.sleep(ms).as(null));
    }

    /**
     * Forks this effect into a new fiber, which starts running concurrently.
     * Returns immediately with a Fiber handle that can be used to join, await or interrupt it.
     * A forked fiber always starts in an interruptible region.
     */
    fork(): URIO<R, Fiber<E, A>> {
        return new TIO<R, never, Fiber<E, A>>({
            _tag: TIOOpTag.Fork,
            run: <B>(cont: <E1, A1>(tio: TIO<R, E1, A1>) => B) => cont(this)
        });
    }

    /** Runs this effect in an interruptible region: it can be interrupted at any step. */
    interruptible(): TIO<R, E, A> {
        return this.setInterruptible(true);
    }

    /** Runs this effect in an uninterruptible region: interruption is deferred until the region is exited. */
    uninterruptible(): TIO<R, E, A> {
        return this.setInterruptible(false);
    }

    private setInterruptible(interruptible: boolean): TIO<R, E, A> {
        return new TIO<R, E, A>({ _tag: TIOOpTag.SetInterruptible, interruptible, run: () => this });
    }

    /** Makes `yield*` usable on a TIO inside `TIO.gen`, evaluating to its success value. */
    *[Symbol.iterator](): Generator<TIO<R, E, A>, A, any> {
        return yield this;
    }

    /**
     * Writes effects in an imperative style, like async/await: inside the generator, `yield*` runs an
     * effect and evaluates to its success value. The first failure short-circuits the rest of the block.
     * The environment and error types are inferred from all the yielded effects.
     *
     * The generator is started each time the effect runs, so the resulting TIO can be run, retried or
     * raced any number of times. Typed failures cannot be caught with try/catch inside the generator:
     * use TIO combinators (`orElse`, `foldM`, ...) on the yielded effect instead.
     *
     * @example
     * ```ts
     * const program = TIO.gen(function* () {
     *     const user = yield* fetchUser(id);
     *     const orders = yield* fetchOrders(user);
     *     return `${user.name}: ${orders.length} orders`;
     * });
     * ```
     */
    static gen<Eff extends TIO<any, any, any>, A>(f: () => Generator<Eff, A, any>): TIO<GenR<Eff>, GenE<Eff>, A> {
        return TIO.flatten(
            TIO.make(() => {
                const iterator = f();
                const step = (input: unknown): TIO<any, any, A> => {
                    const next = iterator.next(input);
                    return next.done ? TIO.succeed(next.value) : next.value.flatMap(step);
                };
                return step(undefined);
            })
        );
    }

    /** Creates an effect from a synchronous function that uses the environment. */
    static make<R, A>(f: (r: R) => A): TIO<R, never, A> {
        return new TIO<R, never, A>({ _tag: TIOOpTag.Sync, f });
    }

    /** Flattens a nested TIO. */
    static flatten<R, E, A>(tio: TIO<R, E, TIO<R, E, A>>): TIO<R, E, A> {
        return tio.flatMap(identity);
    }

    /**
     * Creates an effect from an async callback-based API.
     * `register` may return a Canceler, called if the fiber is interrupted while waiting.
     */
    static async<R, E, A>(
        register: (r: R, resolve: (a: A) => void, reject: (e: E) => void) => Canceler | void
    ): TIO<R, E, A> {
        return new TIO<R, E, A>({ _tag: TIOOpTag.Async, register });
    }

    /** Creates an effect from a Promise. */
    static fromPromise<E, A>(promise: () => Promise<A>, onError: (e: E) => E = identity<E>): IO<E, A> {
        return TIO.async<void, E, A>((_, resolve, reject) => {
            promise()
                .then(resolve)
                .catch((e) => reject(onError(e)));
        });
    }

    /** Creates an effect from an Either. */
    static fromEither<E, A>(either: Either<E, A>): IO<E, A> {
        return fold<E, A, IO<E, A>>(either, TIO.fail<E>, TIO.succeed<A>);
    }

    /** Creates an effect that succeeds with the given value. */
    static succeed<A>(a: A): UIO<A> {
        return new TIO<void, never, A>({ _tag: TIOOpTag.Succeed, value: a });
    }

    /** Creates an effect that fails with the given error. */
    static fail<E>(e: E): IO<E, never> {
        return TIO.failCause(fail(e));
    }

    /** Creates an effect that fails with the given Cause. */
    static failCause<E>(cause: Cause<E>): IO<E, never> {
        return new TIO<void, E, never>({ _tag: TIOOpTag.FailCause, cause });
    }

    /** Creates an effect from a FiberExit: succeeds with its value or fails with its Cause. */
    static fromFiberExit<E, A>(exit: FiberExit<E, A>): IO<E, A> {
        return isFiberSuccess(exit) ? TIO.succeed(exit.value) : TIO.failCause(exit.cause);
    }

    /**
     * Runs the effect returned by `f` in an uninterruptible region.
     * `restore` makes a sub-effect interruptible again if the enclosing region was interruptible.
     */
    static uninterruptibleMask<R, E, A>(f: (restore: Restore) => TIO<R, E, A>): TIO<R, E, A> {
        return new TIO<R, E, A>({
            _tag: TIOOpTag.SetInterruptible,
            interruptible: false,
            run: (previous) => f((tio) => tio.setInterruptible(previous))
        });
    }

    /**
     * Races multiple effects concurrently, returning the first to complete (successfully or not).
     * The losers are interrupted, and the race only completes once they are done.
     */
    static race<R, E, A>(...tios: Array<TIO<R, E, A>>): TIO<R, E, A> {
        if (tios.length === 1) return tios[0];
        return TIO.forkAllMasked(tios, (fibers) =>
            TIO.async<unknown, never, FiberExit<E, A>>((_, resolve) => onEachExit(fibers, resolve))
        ).flatMap(([winner]) => TIO.fromFiberExit(winner));
    }

    /**
     * Runs multiple effects concurrently, collecting all results.
     * Fails as soon as one effect fails, interrupting the others.
     */
    static all<R, E, A>(...tios: Array<TIO<R, E, A>>): TIO<R, E, Array<A>> {
        return TIO.forkAllMasked(tios, (fibers) =>
            TIO.async<unknown, never, void>((_, resolve) => {
                let remaining = fibers.length;
                if (remaining === 0) resolve();
                return onEachExit(fibers, (exit) => {
                    if (!isFiberSuccess(exit) || --remaining === 0) resolve();
                });
            })
        ).flatMap(([, exits]) => TIO.fromFiberExit(mergeExits(exits)));
    }

    /**
     * Forks the effects, waits using `wait`, then interrupts the fibers that are still running and
     * returns the result of `wait` with all the exits. If the current fiber is interrupted while
     * waiting, all the fibers are interrupted too, so that none of them outlives the current one.
     */
    private static forkAllMasked<R, E, A, W>(
        tios: Array<TIO<R, E, A>>,
        wait: (fibers: Array<Fiber<E, A>>) => UIO<W>
    ): URIO<R, [W, Array<FiberExit<E, A>>]> {
        return TIO.uninterruptibleMask((restore) =>
            TIO.forkAll(tios).flatMap((fibers) =>
                restore(wait(fibers)).foldCauseM(
                    (cause) => TIO.interruptAll(fibers).flatMap(() => TIO.failCause(cause)),
                    (w) => TIO.interruptAll(fibers).map((exits): [W, Array<FiberExit<E, A>>] => [w, exits])
                )
            )
        );
    }

    /** Creates an effect that sleeps for the given milliseconds. */
    static sleep(ms: number): UIO<void> {
        return TIO.async<unknown, never, void>((_, resolve) => {
            const handle = setTimeout(resolve, ms);
            return () => clearTimeout(handle);
        });
    }

    /** Never completes - useful for keeping a fiber alive or as a timeout target. */
    static get never(): UIO<never> {
        return TIO.async(() => {
            // Never resolves
        });
    }

    /** Fork an effect to run in a new fiber. */
    static fork<R, E, A>(tio: TIO<R, E, A>): URIO<R, Fiber<E, A>> {
        return tio.fork();
    }

    /** Fork all effects, each in its own fiber. */
    static forkAll<R, E, A>(tios: Array<TIO<R, E, A>>): URIO<R, Array<Fiber<E, A>>> {
        return tios.reduce<URIO<R, Array<Fiber<E, A>>>>(
            (acc, tio) => acc.flatMap((fibers) => tio.fork().map((fiber) => [...fibers, fiber])),
            TIO.succeed([])
        );
    }

    /** Wait for a fiber to complete and return its result, failing if the fiber failed. */
    static joinFiber<E, A>(fiber: Fiber<E, A>): IO<E, A> {
        return TIO.awaitFiber(fiber).flatMap(TIO.fromFiberExit);
    }

    /** Wait for a fiber to complete and return its exit value. */
    static awaitFiber<E, A>(fiber: Fiber<E, A>): UIO<FiberExit<E, A>> {
        return TIO.async<unknown, never, FiberExit<E, A>>((_, resolve) => fiber.unsafeAddObserver(resolve));
    }

    /** Interrupt a fiber and wait for it to complete (including its finalizers). */
    static interruptFiber<E, A>(fiber: Fiber<E, A>): UIO<FiberExit<E, A>> {
        return TIO.make(() => fiber.unsafeInterrupt()).flatMap(() => TIO.awaitFiber(fiber));
    }

    /** Interrupt all fibers and wait for all of them to complete. */
    static interruptAll<E, A>(fibers: Array<Fiber<E, A>>): UIO<Array<FiberExit<E, A>>> {
        return TIO.make(() => fibers.forEach((fiber) => fiber.unsafeInterrupt())).flatMap(() =>
            fibers.reduce<UIO<Array<FiberExit<E, A>>>>(
                (acc, fiber) => acc.flatMap((exits) => TIO.awaitFiber(fiber).map((exit) => [...exits, exit])),
                TIO.succeed([])
            )
        );
    }

    /** Get the status of a fiber. */
    static fiberStatus<E, A>(fiber: Fiber<E, A>): UIO<FiberStatus<E, A>> {
        return TIO.make(() => fiber.unsafeStatus());
    }
}

/** Calls `callback` with the exit of each fiber as it completes. Returns a Canceler removing the observers. */
function onEachExit<E, A>(fibers: Array<Fiber<E, A>>, callback: (exit: FiberExit<E, A>) => void): Canceler {
    const unsubscribes = fibers.map((fiber) => fiber.unsafeAddObserver(callback));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}

/**
 * Merges the exits of parallel fibers: succeeds with all values, or fails with the combined causes.
 * Interruptions are only reported if nothing else went wrong, since they are usually a consequence
 * of another fiber failing.
 */
function mergeExits<E, A>(exits: Array<FiberExit<E, A>>): FiberExit<E, Array<A>> {
    const values: Array<A> = [];
    let cause: Cause<E> = empty;
    let interruptions: Cause<E> = empty;
    for (const exit of exits) {
        if (isFiberSuccess(exit)) values.push(exit.value);
        else if (isInterruptedOnly(exit.cause)) interruptions = both(interruptions, exit.cause);
        else cause = both(cause, exit.cause);
    }
    if (cause._tag !== CauseTag.Empty) return fiberFailure(cause);
    if (interruptions._tag !== CauseTag.Empty) return fiberFailure(interruptions);
    return fiberSuccess(values);
}
