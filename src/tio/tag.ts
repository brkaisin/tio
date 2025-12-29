/**
 * A Tag uniquely identifies a service type in the environment.
 *
 * @template Id - The unique string identifier for this service
 * @template Service - The type of the service
 */
export type Tag<Id extends string, Service> = {
    readonly id: Id;
    /** @internal Phantom type to carry the Service type */
    readonly _S: Service;
}

/**
 * Creates a new Tag for a service.
 *
 * @example
 * ```ts
 * interface Logger { log(msg: string): void }
 * const LoggerTag = tag<"Logger", Logger>("Logger");
 * ```
 */
export function tag<Id extends string, Service>(id: Id): Tag<Id, Service> {
    return { id } as Tag<Id, Service>;
}

/**
 * Extracts the environment type required by a Tag.
 *
 * @example
 * ```ts
 * type HasLogger = Has<typeof LoggerTag>; // { Logger: Logger }
 * ```
 */
export type Has<T extends Tag<string, unknown>> =
    T extends Tag<infer I, infer S>
        ? { [K in I]: S }
        : never
