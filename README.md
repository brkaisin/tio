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

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](./docs/getting-started.md) | Quick introduction and basic usage |
| [Core Concepts](./docs/core-concepts.md) | Deep dive into TIO's design and operations |
| [Fibers](./docs/fibers.md) | Concurrent execution with lightweight virtual threads |
| [Error Handling](./docs/error-handling.md) | Rich error information with Cause |
| [Dependency Injection](./docs/dependency-injection.md) | Type-safe dependency management |

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

## The TIO Type

```typescript
TIO<R, E, A>
```

| Parameter | Description |
|-----------|-------------|
| `R` | The environment/dependencies the effect needs to run |
| `E` | The type of errors the effect can fail with |
| `A` | The type of the success value |

## Quick Example

```typescript
import { TIO } from "tio/tio";
import { Runtime } from "tio/runtime";

// Create an effect (nothing executes yet)
const effect = TIO.succeed(42)
    .map(x => x * 2)
    .flatMap(x => TIO.succeed(`Result: ${x}`));

// Run the effect
const result = await Runtime.default.unsafeRun(effect);
console.log(result); // "Result: 84"
```

## Key Features

### Lazy Execution

Unlike Promises, TIO effects don't execute until you run them:

```typescript
// This doesn't make an HTTP request
const effect = TIO.fromPromise(() => fetch("/api/data"));

// This does
await Runtime.default.unsafeRun(effect);
```

### Typed Errors

Errors are part of the type signature:

```typescript
const divide = (a: number, b: number): TIO<never, "division by zero", number> =>
    b === 0 ? TIO.fail("division by zero") : TIO.succeed(a / b);
```

### Dependency Injection

Dependencies are type-checked at compile time:

```typescript
const log = (msg: string): TIO<{ Logger: Logger }, never, void> =>
    TIO.make((env) => env.Logger.log(msg));

// Runtime must provide Logger
const runtime = Runtime.default.provideService(LoggerTag, myLogger);
```

### Concurrent Execution with Fibers

Fork effects to run concurrently:

```typescript
const program = TIO.succeed(42)
    .delay(100)
    .fork()
    .flatMap((fiber) => TIO.joinFiber(fiber));
```

### Rich Error Information

Causes capture the complete failure story:

```typescript
const exit = await runtime.unsafeRun(
    effect.fork().flatMap((f) => TIO.awaitFiber(f))
);

if (exit._tag === "Failure") {
    console.log(prettyPrint(exit.cause));
}
```

## Running Tests

```bash
npm install
npm test
```

## License

This project is licensed under the MIT license. See [LICENSE](LICENSE.txt).

## Contributing

If you want to contribute, fork the repository and create a pull request. Feel free to open an issue for questions.

## Todo

- [ ] Configure prettier hook to format code

