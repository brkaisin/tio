import { identity } from "./util/functions";
import { IO, UIO, URIO } from "./aliases";
import { Either, fold } from "./util/either";

export class TIO<in R, out E, out A> {
    constructor(private readonly run: (r: R) => Promise<A>) {}

    map<B>(f: (a: A) => B): TIO<R, E, B> {
        return new TIO<R, E, B>((r) => this.run(r).then(f));
    }

    mapError<E1>(f: (e: E) => E1): TIO<R, E1, A> {
        return new TIO<R, E1, A>((r) => this.run(r).catch(e => Promise.reject(f(e))));
    }

    mapBoth<E1, B>(f: (e: E) => E1, g: (a: A) => B): TIO<R, E1, B> {
        return this.map(g).mapError(f);
    }

    flatMap<R1, E1, B>(f: (a: A) => TIO<R1, E1, B>): TIO<R & R1, E | E1, B> {
        return new TIO<R & R1, E | E1, B>((r) => this.run(r).then(a => f(a).run(r)));
    }

    flatMapError<E1>(f: (e: E) => TIO<R, never, E1>): TIO<R, E1, A> {
        return this.flipWith(tio => tio.flatMap(f));
    }

    orElse<R1, E1, B>(that: TIO<R1, E1, B>): TIO<R & R1, E | E1, A | B> {
        return new TIO<R & R1, E | E1, A | B>((r) =>
            this.run(r).catch(() => that.run(r))
        );
    }

    tap(f: (a: A) => void): TIO<R, E, A> {
        return this.map(a => {
            f(a);
            return a;
        });
    }

    tapError(f: (e: E) => void): TIO<R, E, A> {
        return this.mapError(e => {
            f(e);
            return e;
        });
    }

    tapBoth(f: (a: A) => void, g: (e: E) => void): TIO<R, E, A> {
        return this.tap(f).tapError(g);
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

    foldM<R1, B, E1>(onError: (e: E) => TIO<R1, E1, B>, onSuccess: (a: A) => TIO<R1, E1, B>): TIO<R & R1, E1, B> {
        return new TIO<R & R1, E1, B>((r) => this.run(r).then(
            a => onSuccess(a).run(r),
            e => onError(e).run(r)
        ));
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
        return new TIO<R & R1, E, [A, B]>((r) => Promise.all([this.run(r), that.run(r)]));
    }

    zipWith<R1, B, C>(that: TIO<R1, E, B>, f: (a: A, b: B) => C): TIO<R & R1, E, C> {
        return this.zip(that).map(([a, b]) => f(a, b));
    }

    retry(n: number): TIO<R, E, A> {
        const attempt: (r: R, count: number) => Promise<A> = (r: R, count: number): Promise<A> =>
            (count <= 0) ? this.run(r) : this.run(r).catch(() => attempt(r, count - 1))
        return new TIO<R, E, A>((r) => attempt(r, n));
    }

    race<R1, E1, B>(that: TIO<R1, E1, B>): TIO<R & R1, E | E1, A | B> {
        return this.raceAll(that);
    }

    // Note: Due to JavaScript's single-threaded nature, synchronous operations inside Promise
    // executors cannot be truly "raced" - they run to completion before any other code executes.
    // This race implementation works correctly for async operations (e.g., setTimeout, fetch),
    // but synchronous CPU-bound tasks will complete in the order they are started.
    // True parallelism for synchronous operations would require Worker Threads.
    raceAll<R1, E1, B>(...tios: Array<TIO<R1, E1, B>>): TIO<R & R1, E | E1, A | B> {
        return new TIO<R & R1, E | E1, A | B>((r) => Promise.race([this.run(r), ...tios.map(tio => tio.run(r))]));
    }

    timeout(ms: number): TIO<R, E, A | null> {
        const timeoutM: TIO<R, E, null> = new TIO<R, E, null>((_) => new Promise(resolve => setTimeout(() => resolve(null), ms)));
        return this.race(timeoutM);
    }

    static make<R, E, A>(f: (r: R) => A): TIO<R, E, A> {
        return new TIO<R, E, A>((r) => Promise.resolve(f(r)));
    }

    static flatten<R, E, A>(tio: TIO<R, E, TIO<R, E, A>>): TIO<R, E, A> {
        return tio.flatMap(identity);
    }

    static fromPromise<E, A>(promise: () => Promise<A>, onError: (e: E) => E = identity<E>): IO<E, A> {
        return new TIO<void, E, A>(() => promise().catch(e => Promise.reject(onError(e))));
    }

    static fromEither<E, A>(either: Either<E, A>): IO<E, A> {
        return fold<E, A, IO<E, A>>(either, TIO.fail<E>, TIO.succeed<A>);
    }

    static succeed<A>(a: A): UIO<A> {
        return TIO.fromPromise<never, A>(() => Promise.resolve(a));
    }

    static fail<E>(e: E): IO<E, never> {
        return TIO.fromPromise<E, never>(() => Promise.reject(e));
    }
}
