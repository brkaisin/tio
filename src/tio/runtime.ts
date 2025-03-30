import { TIO } from "./tio";
import { Either, left, right } from "./util/either";
import { identity } from "./util/functions";
import { Has, Tag } from "./tag";
import { Exit, failure, success } from "./util/exit";

export class Runtime<in R> {
    constructor(private readonly services: Record<string, unknown>) {}

    private run<E, A>(tio: TIO<R, E, A>): Promise<A> {
        return tio['run'](this.services as R);
    }

    unsafeRun<E, A>(tio: TIO<R, E, A>): Promise<A> {
        return this.run(tio);
    }

    safeRunEither<E, A>(tio: TIO<R, E, A>): Promise<Either<E, A>> {
        return this.run(tio).then(right).catch(left);
    }

    safeRunExit<E, A>(tio: TIO<R, E, A>): Promise<Exit<E, A>> {
        return this.run(tio).then(success).catch(failure);
    }

    safeRunUnion<E, A>(tio: TIO<R, E, A>): Promise<E | A> {
        return this.run(tio).catch(identity);
    }

    provideService<Id extends string, S>(tag: Tag<Id, S>, service: S): Runtime<R & Has<Tag<Id, S>>> {
        return new Runtime({
            ...this.services,
            [tag.id]: service,
        });
    }

    static default: Runtime<unknown> = new Runtime({});
}

