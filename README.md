# TIO

TIO is probably the simplest functional effect system you can imagine in TypeScript. It is inspired by
the [ZIO](https://zio.dev/) library for Scala, but it is much more basic and waaaaay less powerful. For a more
complete "alternative" to ZIO in TypeScript, check out the wonderful [Effect-TS](https://github.com/Effect-TS/effect)
library.

> :warning: **TIO is new**: TIO is at version 0.0.1 and only contains the most basic functionality, which is
> constructing and running effects from/to promises. In the future, I might add more features, but for now, this is it.
> So don't expect too much from this library yet.

To be honest, this library is more of a learning project and a vengeance against promises in TypeScript than a serious
attempt to create a useful library. But who knows, maybe it will find its place in the world.

## What is a functional effect system?

An effect system is a way to describe side effects in a purely functional program. In a purely functional language, side
effects are avoided because they would violate _referential transparency_ — the property that ensures expressions can be
replaced by their values without changing the programs behavior. However, in real-world applications, interacting with
the outside world is essential, and that's where effect systems come into play. The goal of an effect system is to model
side effects in a way that allows the program to remain pure by deferring their execution until the appropriate time.
This enables side effects to be pushed to the boundaries of the program, where they can be handled in a controlled and
predictable manner.

## What is TIO?

TIO is a simple effect system that allows you to describe side effects in a purely functional way. It was born out of
frustration while working with promises in TypeScript. Probably the most annoying thing about promises is that they
are eager and do not feature a typed error channel. TIO addresses all of these problems.

## How does TIO work?

TIO is a pure data structure (an Algebraic Data Type) that describes effectful computations without executing them.
Each TIO operation (like `map`, `flatMap`, `race`, etc.) builds up a tree of operations. The actual execution
is handled by the `Runtime`, which interprets this tree.

This separation of description and execution means:
- TIO is truly lazy and referentially transparent
- The execution strategy is determined by the Runtime
- Different Runtimes could be created for testing, tracing, or alternative execution models

The `TIO<R, E, A>` type has three type parameters:
- `R`: The environment/dependencies the effect needs to run
- `E`: The type of errors the effect can fail with
- `A`: The type of the success value

To effectively run an effect, you need to provide a `Runtime` that contains all the dependencies that the effect needs
to run.

## Example

Here is a simple example of a TIO effect that is created from a `Promise` that can fail:

```typescript
import { TIO } from "tio/tio";
import { IO } from "tio/aliases";
import { Runtime } from "tio/runtime";

const effect: IO<unknown, number> = TIO.fromPromise(() => Promise.resolve(42));

// at this stage, the promise is not yet executed and can be composed with other effects

const result: number = await Runtime.default.unsafeRun(effect); // 42
```

Effects can also be directly created from values:

```typescript
import { IO, UIO } from "tio/aliases";
import { TIO } from "tio/tio";
import { Runtime } from "tio/runtime";
import { Exit } from "tio/util/exit";

const effectSuccess: UIO<number> = TIO.succeed(42);
const effectFailure: IO<string, never> = TIO.fail("error");

const success: number = await Runtime.default.unsafeRun(effectSuccess); // 42
const failureUnsafe: never = await Runtime.default.unsafeRun(effectFailure); // throws the error
const failureSafe: Exit<string, never> = await Runtime.default.safeRunExit(effectFailure); // { error: "error" }
```

Finally, here is a more complex example with dependencies and effect composition:

```typescript
import { TIO } from "tio/tio";
import { URIO } from "tio/aliases";
import { Runtime } from "tio/runtime";
import { tag, Has, Tag } from "tio/tag";
import { fold } from "tio/util/exit";

type DbResult = { result: unknown }

interface DB {
    query(sql: string): Promise<DbResult>
}

interface Logger {
    log(s: string): void
}

const LoggerTag: Tag<"Logger", Logger> = tag("Logger");
const DBTag: Tag<"DB", DB> = tag("DB");

const logger: Logger = {log: console.log};
const db: DB = {
    query(sql: string): Promise<DbResult> {
        if (Math.random() > 0.2) {
            // the DB crashes 80% of the time
            return Promise.reject(`Query [${sql}] failed.`);
        } else {
            return Promise.resolve({result: `Query [${sql}] was executed successfully.`});
        }
    }
};

type HasLogger = Has<typeof LoggerTag>
type HasDB = Has<typeof DBTag>

function log(s: string): URIO<HasLogger, void> {
    return TIO.make<HasLogger, void>((env) => env.Logger.log(s));
}

type DbError = string

function queryDb(sql: string): TIO<HasDB, DbError, DbResult> {
    return TIO.async<HasDB, DbError, DbResult>((env, resolve, reject) => {
        env.DB.query(sql).then(resolve).catch(reject);
    });
}

type Env = HasLogger & HasDB

const queryDbAndLogResult: TIO<Env, DbError, void> =
    queryDb("SELECT * FROM some_table")
        .tap(result => log(`Query succeeded: ${JSON.stringify(result)}`))
        .tapError(error => log(`Query failed: ${error}`))
        .retry(2)
        .map(JSON.stringify)
        .flatMap(log)

const runtime: Runtime<Env> = Runtime.default
    .provideService(LoggerTag, logger)
    .provideService(DBTag, db);

runtime.safeRunExit(queryDbAndLogResult)
    .then(result =>
        fold(
            result,
            (error) => console.log(`Program encountered this error: ${error}`),
            (value) => console.log(`Program exited successfully with ${value}`)
        )
    );
```

As you can see, **everything is pure** until the `Runtime` is used to run the effect.
Feel free to run this program (`npm run main`) and see the output. You can also play with the code
in [index.ts](src/index.ts).

## Testing

The tests are written using [Vitest](https://vitest.dev/), a Vite-native testing framework.

Before running the tests, you need to install the dependencies (you will need to have the latest version of Node.js and
npm installed on your machine):

There is also a playground in [index.ts](src/index.ts) where you can play with the library.

```bash
npm install
```

To run the tests, you can use the following command:

```bash
npm test
```

## License

This project is licensed under the MIT license. You can find the full text of the license in the [LICENSE](LICENSE.txt)
file.

This project was inspired by [ZIO](https://zio.dev/), a powerful functional effect library for Scala. If, in the future,
the resemblance becomes too important, conditions of the Apache 2.0 license will be applied.

## Contributing

If you want to contribute to this project, you can fork the repository and create a pull request. I will review it as
soon as possible. If you have any questions, feel free to open an issue.

## Todo

- [ ] Write tests for runtime
- [ ] Configure prettier/hook to format code
