export const _: unique symbol = Symbol("ev");
type __ = typeof _

export type Equals<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? __ : false

export type SubType<A, B> = A extends B ? __ : false

export type IsNever<A> = Equals<A, never>

export type SuperType<A, B> = SubType<B, A>

export type CanFail<E> = Equals<E, never> extends __ ? false : __

function unsafeCast<From, To>(from: From): To {
    return from as unknown as To;
}

export function subType<A, B>(a: A, _: SubType<A, B>): B {
    return unsafeCast(a);
}

export function superType<A, B>(a: A, _: SuperType<B, A>): B {
    return unsafeCast(a);
}
