export type Failure<out E, out A = never> = {
    readonly error: E;
};

export type Success<out A, out E = never> = {
    readonly value: A;
};

export type Exit<E, A> = Failure<E, A> | Success<A, E>;

export function failure<E, A = never>(error: E): Failure<E, A> {
    return { error };
}

export function success<A, E = never>(value: A): Success<A, E> {
    return { value };
}

export function isSuccess<E, A>(exit: Exit<E, A>): exit is Success<A, E> {
    return "value" in exit;
}

export function isFailure<E, A>(exit: Exit<E, A>): exit is Failure<E, A> {
    return "error" in exit;
}

export function fold<E, A, O>(exit: Exit<E, A>, onFailure: (e: E) => O, onSuccess: (a: A) => O): O {
    if (isFailure(exit)) {
        return onFailure(exit.error);
    } else {
        return onSuccess(exit.value);
    }
}
