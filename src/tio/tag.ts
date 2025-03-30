export type Tag<Id, Service> = {
    readonly id: Id;
    readonly _S: () => Service;
}

export function tag<Id, Service>(id: Id): Tag<Id, Service> {
    return {
        id,
        _S: () => undefined as Service,
    };
}


export type Has<T extends Tag<unknown, unknown>> =
    T extends Tag<infer I, infer S>
        ? I extends string
            ? { [K in I]: S }
            : never
        : never
