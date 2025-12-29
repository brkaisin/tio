export const enum CauseTag {
    Empty = "Empty",
    Fail = "Fail",
    Die = "Die",
    Interrupt = "Interrupt",
    Then = "Then",
    Both = "Both"
}

/**
 * Cause represents the full story of why an effect failed.
 *
 * Unlike simple error types, Cause captures:
 * - Regular failures (Fail)
 * - Defects/unexpected errors (Die)
 * - Interruption (Interrupt)
 * - Combined failures from parallel operations (Both)
 * - Sequential failures from finalizers (Then)
 */
export type Cause<E> =
    | { readonly _tag: CauseTag.Empty }
    | { readonly _tag: CauseTag.Fail; readonly error: E }
    | { readonly _tag: CauseTag.Die; readonly defect: unknown }
    | { readonly _tag: CauseTag.Interrupt; readonly fiberId: FiberId }
    | { readonly _tag: CauseTag.Then; readonly left: Cause<E>; readonly right: Cause<E> }
    | { readonly _tag: CauseTag.Both; readonly left: Cause<E>; readonly right: Cause<E> };

export function isCauseFail<E>(cause: Cause<E>): cause is { readonly _tag: CauseTag.Fail; readonly error: E } {
    return cause._tag === CauseTag.Fail;
}

/**
 * A unique identifier for a Fiber.
 */
export type FiberId = {
    readonly id: number;
    readonly startTime: number;
};

let fiberIdCounter = 0;

export function makeFiberId(): FiberId {
    return {
        id: fiberIdCounter++,
        startTime: Date.now()
    };
}

export const empty: Cause<never> = { _tag: CauseTag.Empty };

export function fail<E>(error: E): Cause<E> {
    return { _tag: CauseTag.Fail, error };
}

export function die(defect: unknown): Cause<never> {
    return { _tag: CauseTag.Die, defect };
}

export function interrupt(fiberId: FiberId): Cause<never> {
    return { _tag: CauseTag.Interrupt, fiberId };
}

export function sequential<E>(left: Cause<E>, right: Cause<E>): Cause<E> {
    if (left._tag === CauseTag.Empty) return right;
    if (right._tag === CauseTag.Empty) return left;
    return { _tag: CauseTag.Then, left, right };
}

export function both<E>(left: Cause<E>, right: Cause<E>): Cause<E> {
    if (left._tag === CauseTag.Empty) return right;
    if (right._tag === CauseTag.Empty) return left;
    return { _tag: CauseTag.Both, left, right };
}

export function isEmpty<E>(cause: Cause<E>): boolean {
    return cause._tag === CauseTag.Empty;
}

export function isFailure<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case CauseTag.Fail:
            return true;
        case CauseTag.Then:
        case CauseTag.Both:
            return isFailure(cause.left) || isFailure(cause.right);
        default:
            return false;
    }
}

export function isInterrupted<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case CauseTag.Interrupt:
            return true;
        case CauseTag.Then:
        case CauseTag.Both:
            return isInterrupted(cause.left) || isInterrupted(cause.right);
        default:
            return false;
    }
}

export function isDie<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case CauseTag.Die:
            return true;
        case CauseTag.Then:
        case CauseTag.Both:
            return isDie(cause.left) || isDie(cause.right);
        default:
            return false;
    }
}

export function failures<E>(cause: Cause<E>): E[] {
    switch (cause._tag) {
        case CauseTag.Empty:
        case CauseTag.Die:
        case CauseTag.Interrupt:
            return [];
        case CauseTag.Fail:
            return [cause.error];
        case CauseTag.Then:
        case CauseTag.Both:
            return [...failures(cause.left), ...failures(cause.right)];
    }
}

export function defects<E>(cause: Cause<E>): unknown[] {
    switch (cause._tag) {
        case CauseTag.Empty:
        case CauseTag.Fail:
        case CauseTag.Interrupt:
            return [];
        case CauseTag.Die:
            return [cause.defect];
        case CauseTag.Then:
        case CauseTag.Both:
            return [...defects(cause.left), ...defects(cause.right)];
    }
}

export function interruptors<E>(cause: Cause<E>): FiberId[] {
    switch (cause._tag) {
        case CauseTag.Empty:
        case CauseTag.Fail:
        case CauseTag.Die:
            return [];
        case CauseTag.Interrupt:
            return [cause.fiberId];
        case CauseTag.Then:
        case CauseTag.Both:
            return [...interruptors(cause.left), ...interruptors(cause.right)];
    }
}

export function map<E, E1>(cause: Cause<E>, f: (e: E) => E1): Cause<E1> {
    switch (cause._tag) {
        case CauseTag.Empty:
            return empty;
        case CauseTag.Fail:
            return fail(f(cause.error));
        case CauseTag.Die:
            return die(cause.defect);
        case CauseTag.Interrupt:
            return interrupt(cause.fiberId);
        case CauseTag.Then:
            return sequential(map(cause.left, f), map(cause.right, f));
        case CauseTag.Both:
            return both(map(cause.left, f), map(cause.right, f));
    }
}

/**
 * Squash a Cause into a single error.
 * Priority: Failures > Defects > Interrupts
 */
export function squash<E>(cause: Cause<E>): E | unknown | FiberId | undefined {
    const fails = failures(cause);
    if (fails.length > 0) return fails[0];

    const dies = defects(cause);
    if (dies.length > 0) return dies[0];

    const interrupts = interruptors(cause);
    if (interrupts.length > 0) return interrupts[0];

    return undefined;
}

/**
 * Pretty print a Cause for debugging.
 */
export function prettyPrint<E>(cause: Cause<E>): string {
    switch (cause._tag) {
        case CauseTag.Empty:
            return "Empty";
        case CauseTag.Fail:
            return `Fail(${String(cause.error)})`;
        case CauseTag.Die:
            return `Die(${String(cause.defect)})`;
        case CauseTag.Interrupt:
            return `Interrupt(Fiber#${cause.fiberId.id})`;
        case CauseTag.Then:
            return `Then(${prettyPrint(cause.left)}, ${prettyPrint(cause.right)})`;
        case CauseTag.Both:
            return `Both(${prettyPrint(cause.left)}, ${prettyPrint(cause.right)})`;
    }
}
