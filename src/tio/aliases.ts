import { TIO } from "./tio";

export type IO<E, A> = TIO<any, E, A>;
export type Task<A> = IO<Error, A>;
export type RIO<R, A> = TIO<R, Error, A>;
export type UIO<A> = IO<never, A>;
export type URIO<R, A> = TIO<R, never, A>;
