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

TIO is a simple wrapper around a function that takes an argument of type `R` and returns a `Promise<A>`. This `Promise`
can fail with an error of type `E`. The `R` type is the environment that the effect needs to run. This can be anything,
but it is usually an object that contains all the dependencies that the effect needs to run.

To effectively run an effect, you need to provide a `Runtime` that contains all the dependencies that the effect needs
to run.

## Example

Here is a simple example of a TIO effect that is created from a `Promise` that can fail:

```typescript
import { IO, TIO } from 'tio';

const effect: IO<unknown, number> = TIO.fromPromise(() => Promise.resolve(42));

const result: number = await effect.unsafeRun(); // 42
```

Effects can also be directly created from values:

```typescript
import { TIO, UIO } from 'tio';

const effectSuccess: UIO<number> = TIO.succeed(42);
const effectFailure: IO<string, never> = TIO.fail("error");

const success: number = await effectSuccess.unsafeRun(); // 42
const failure: never = await effectFailure.unsafeRun(); // throws an error
```

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

This project was inspired by [ZIO](https://zio.dev/), a powerful functional effect library for Scala. While no code was
directly copied, the concepts and design patterns influenced this work. If, in the future, the resemblance becomes too
important, conditions of the Apache 2.0 license will be applied.

## Contributing

If you want to contribute to this project, you can fork the repository and create a pull request. I will review it as
soon as possible. If you have any questions, feel free to open an issue.

## Todo

- [] Fix todos
- [] Fix tests (not all passing)
- [] Write tests for runtime
- [] rework tap and tapError to take TIO as arguments for purity
- [] Check `fromPromise` to probably take `R` and remake `make` method (avoid direct usages of TIO constructor)
- Configure prettier/hook to format code
