export type Left<out L, out R = never> = {
    readonly left: L;
};

export type Right<out R, out L = never> = {
    readonly right: R;
};

export type Either<L, R> = Left<L, R> | Right<R, L>;

export function left<L, R = never>(left: L): Left<L, R> {
    return { left };
}

export function right<R, L = never>(right: R): Right<R, L> {
    return { right };
}

export function isRight<L, R>(either: Either<L, R>): either is Right<R, L> {
    return "right" in either;
}

export function isLeft<L, R>(either: Either<L, R>): either is Left<L, R> {
    return "left" in either;
}

export function fold<L, R, O>(either: Either<L, R>, onLeft: (l: L) => O, onRight: (r: R) => O): O {
    if (isLeft(either)) {
        return onLeft(either.left);
    } else {
        return onRight(either.right);
    }
}
