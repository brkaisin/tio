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
    | { readonly _tag: "Empty" }
    | { readonly _tag: "Fail"; readonly error: E }
    | { readonly _tag: "Die"; readonly defect: unknown }
    | { readonly _tag: "Interrupt"; readonly fiberId: FiberId }
    | { readonly _tag: "Then"; readonly left: Cause<E>; readonly right: Cause<E> }
    | { readonly _tag: "Both"; readonly left: Cause<E>; readonly right: Cause<E> };

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

// Constructors
export const empty: Cause<never> = { _tag: "Empty" };

export function fail<E>(error: E): Cause<E> {
    return { _tag: "Fail", error };
}

export function die(defect: unknown): Cause<never> {
    return { _tag: "Die", defect };
}

export function interrupt(fiberId: FiberId): Cause<never> {
    return { _tag: "Interrupt", fiberId };
}

export function sequential<E>(left: Cause<E>, right: Cause<E>): Cause<E> {
    if (left._tag === "Empty") return right;
    if (right._tag === "Empty") return left;
    return { _tag: "Then", left, right };
}

export function both<E>(left: Cause<E>, right: Cause<E>): Cause<E> {
    if (left._tag === "Empty") return right;
    if (right._tag === "Empty") return left;
    return { _tag: "Both", left, right };
}

// Predicates
export function isEmpty<E>(cause: Cause<E>): boolean {
    return cause._tag === "Empty";
}

export function isFailure<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case "Fail":
            return true;
        case "Then":
        case "Both":
            return isFailure(cause.left) || isFailure(cause.right);
        default:
            return false;
    }
}

export function isInterrupted<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case "Interrupt":
            return true;
        case "Then":
        case "Both":
            return isInterrupted(cause.left) || isInterrupted(cause.right);
        default:
            return false;
    }
}

export function isDie<E>(cause: Cause<E>): boolean {
    switch (cause._tag) {
        case "Die":
            return true;
        case "Then":
        case "Both":
            return isDie(cause.left) || isDie(cause.right);
        default:
            return false;
    }
}

// Extractors
export function failures<E>(cause: Cause<E>): E[] {
    switch (cause._tag) {
        case "Empty":
        case "Die":
        case "Interrupt":
            return [];
        case "Fail":
            return [cause.error];
        case "Then":
        case "Both":
            return [...failures(cause.left), ...failures(cause.right)];
    }
}

export function defects<E>(cause: Cause<E>): unknown[] {
    switch (cause._tag) {
        case "Empty":
        case "Fail":
        case "Interrupt":
            return [];
        case "Die":
            return [cause.defect];
        case "Then":
        case "Both":
            return [...defects(cause.left), ...defects(cause.right)];
    }
}

export function interruptors<E>(cause: Cause<E>): FiberId[] {
    switch (cause._tag) {
        case "Empty":
        case "Fail":
        case "Die":
            return [];
        case "Interrupt":
            return [cause.fiberId];
        case "Then":
        case "Both":
            return [...interruptors(cause.left), ...interruptors(cause.right)];
    }
}

// Transformations
export function map<E, E1>(cause: Cause<E>, f: (e: E) => E1): Cause<E1> {
    switch (cause._tag) {
        case "Empty":
            return empty;
        case "Fail":
            return fail(f(cause.error));
        case "Die":
            return die(cause.defect);
        case "Interrupt":
            return interrupt(cause.fiberId);
        case "Then":
            return sequential(map(cause.left, f), map(cause.right, f));
        case "Both":
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
        case "Empty":
            return "Empty";
        case "Fail":
            return `Fail(${String(cause.error)})`;
        case "Die":
            return `Die(${String(cause.defect)})`;
        case "Interrupt":
            return `Interrupt(Fiber#${cause.fiberId.id})`;
        case "Then":
            return `Then(${prettyPrint(cause.left)}, ${prettyPrint(cause.right)})`;
        case "Both":
            return `Both(${prettyPrint(cause.left)}, ${prettyPrint(cause.right)})`;
    }
}
