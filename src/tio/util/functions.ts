export function identity<X>(x: X): X {
    return x;
}

export function isNever(_: never): never {
    throw new Error("This code should be unreachable");
}
