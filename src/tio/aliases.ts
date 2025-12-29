import { TIO } from "./tio";

/**
 * Common type aliases for TIO with specific type constraints.
 * These mirror ZIO's type aliases for convenience.
 */

/** An effect that requires no environment but can fail with E or succeed with A. */
export type IO<E, A> = TIO<any, E, A>;

/** An effect that requires no environment and fails with Error or succeeds with A. */
export type Task<A> = IO<Error, A>;

/** An effect that requires R, fails with Error, and succeeds with A. */
export type RIO<R, A> = TIO<R, Error, A>;

/** An effect that requires no environment and cannot fail (infallible). */
export type UIO<A> = IO<never, A>;

/** An effect that requires R and cannot fail (infallible). */
export type URIO<R, A> = TIO<R, never, A>;
