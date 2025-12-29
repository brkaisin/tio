# Dependency Injection with Environment

TIO's environment system (`R` parameter) provides compile-time safe dependency injection without any runtime framework.

## The Problem

Applications need dependencies: databases, loggers, HTTP clients, configuration, etc. Common approaches have drawbacks:

| Approach | Problem |
|----------|---------|
| Global singletons | Hard to test, hidden dependencies |
| Constructor injection | Verbose, manual wiring |
| DI frameworks | Runtime errors, magic |

TIO's approach: **dependencies are part of the type**.

## The R Parameter

In `TIO<R, E, A>`, the `R` parameter represents the **environment** the effect needs to run:

```typescript
// This effect needs a Logger to run
const logMessage: TIO<{ Logger: Logger }, never, void> = 
    TIO.make((env) => env.Logger.log("Hello!"));

// This effect needs nothing
const pure: TIO<never, never, number> = TIO.succeed(42);
```

## Defining Services

### Step 1: Define the Interface

```typescript
interface Logger {
    log(message: string): void;
    error(message: string): void;
}

interface Database {
    query(sql: string): Promise<unknown>;
}

interface Config {
    apiUrl: string;
    timeout: number;
}
```

### Step 2: Create Service Tags

Tags provide type-safe keys for services:

```typescript
import { tag, Tag, Has } from "tio/tag";

const LoggerTag: Tag<"Logger", Logger> = tag("Logger");
const DatabaseTag: Tag<"Database", Database> = tag("Database");
const ConfigTag: Tag<"Config", Config> = tag("Config");
```

### Step 3: Define Environment Types

```typescript
type HasLogger = Has<typeof LoggerTag>;
type HasDatabase = Has<typeof DatabaseTag>;
type HasConfig = Has<typeof ConfigTag>;

// Combined environment
type AppEnv = HasLogger & HasDatabase & HasConfig;
```

## Using Services

### Accessing Services in Effects

```typescript
// Effect that uses Logger
function log(message: string): TIO<HasLogger, never, void> {
    return TIO.make((env) => env.Logger.log(message));
}

// Effect that uses Database
function query(sql: string): TIO<HasDatabase, string, unknown> {
    return TIO.async((env, resolve, reject) => {
        env.Database.query(sql).then(resolve).catch(reject);
    });
}

// Effect that uses Config
function getApiUrl(): TIO<HasConfig, never, string> {
    return TIO.make((env) => env.Config.apiUrl);
}
```

### Combining Services

When you compose effects, their environments are merged:

```typescript
const program: TIO<HasLogger & HasDatabase, string, void> =
    log("Starting query...")
        .flatMap(() => query("SELECT * FROM users"))
        .flatMap((result) => log(`Got ${result}`));
```

## Providing Services

### Using provideService

```typescript
const logger: Logger = {
    log: console.log,
    error: console.error
};

const database: Database = {
    query: (sql) => Promise.resolve([{ id: 1 }])
};

const config: Config = {
    apiUrl: "https://api.example.com",
    timeout: 5000
};

// Build the runtime with services
const runtime = Runtime.default
    .provideService(LoggerTag, logger)
    .provideService(DatabaseTag, database)
    .provideService(ConfigTag, config);

// Now we can run effects that need these services
await runtime.unsafeRun(program);
```

### Type Safety

The compiler ensures you provide all required services:

```typescript
const needsLogger: TIO<HasLogger, never, void> = log("test");

// ❌ Type error! Runtime doesn't have Logger
await Runtime.default.unsafeRun(needsLogger);

// ✅ Works! Logger is provided
const withLogger = Runtime.default.provideService(LoggerTag, logger);
await withLogger.unsafeRun(needsLogger);
```

## Testing with Mock Services

One of the biggest benefits: easy testing with mock implementations.

```typescript
// Production logger
const realLogger: Logger = {
    log: (msg) => console.log(`[LOG] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`)
};

// Test logger that captures messages
const createTestLogger = () => {
    const messages: string[] = [];
    const logger: Logger = {
        log: (msg) => messages.push(msg),
        error: (msg) => messages.push(`ERROR: ${msg}`)
    };
    return { logger, messages };
};

// In your test
test("logs messages correctly", async () => {
    const { logger, messages } = createTestLogger();
    const testRuntime = Runtime.default.provideService(LoggerTag, logger);
    
    await testRuntime.unsafeRun(log("Hello"));
    
    expect(messages).toEqual(["Hello"]);
});
```

## Layered Architecture

For larger applications, organize services in layers:

```typescript
// Layer 1: Infrastructure
const LoggerTag = tag("Logger");
const HttpClientTag = tag("HttpClient");

// Layer 2: Repositories (depend on infrastructure)
const UserRepositoryTag = tag("UserRepository");
const OrderRepositoryTag = tag("OrderRepository");

// Layer 3: Services (depend on repositories)
const UserServiceTag = tag("UserService");
const OrderServiceTag = tag("OrderService");

// Build runtime layer by layer
const infrastructureRuntime = Runtime.default
    .provideService(LoggerTag, consoleLogger)
    .provideService(HttpClientTag, fetchClient);

const repositoryRuntime = infrastructureRuntime
    .provideService(UserRepositoryTag, createUserRepo(/* uses HttpClient */))
    .provideService(OrderRepositoryTag, createOrderRepo(/* uses HttpClient */));

const appRuntime = repositoryRuntime
    .provideService(UserServiceTag, createUserService(/* uses repos */))
    .provideService(OrderServiceTag, createOrderService(/* uses repos */));
```

## Complete Example

```typescript
import { TIO } from "tio/tio";
import { Runtime } from "tio/runtime";
import { tag, Tag, Has } from "tio/tag";

// ============ Service Definitions ============

interface Logger {
    info(msg: string): void;
    error(msg: string): void;
}

interface UserRepository {
    findById(id: number): Promise<User | null>;
    save(user: User): Promise<void>;
}

interface User {
    id: number;
    name: string;
    email: string;
}

// ============ Tags ============

const LoggerTag: Tag<"Logger", Logger> = tag("Logger");
const UserRepoTag: Tag<"UserRepo", UserRepository> = tag("UserRepo");

type HasLogger = Has<typeof LoggerTag>;
type HasUserRepo = Has<typeof UserRepoTag>;
type AppEnv = HasLogger & HasUserRepo;

// ============ Service Functions ============

function logInfo(msg: string): TIO<HasLogger, never, void> {
    return TIO.make((env) => env.Logger.info(msg));
}

function logError(msg: string): TIO<HasLogger, never, void> {
    return TIO.make((env) => env.Logger.error(msg));
}

function findUser(id: number): TIO<HasUserRepo, string, User> {
    return TIO.async<HasUserRepo, string, User>((env, resolve, reject) => {
        env.UserRepo.findById(id)
            .then((user) => user ? resolve(user) : reject("User not found"))
            .catch((e) => reject(String(e)));
    });
}

// ============ Business Logic ============

function getUser(id: number): TIO<AppEnv, string, User> {
    return logInfo(`Fetching user ${id}`)
        .flatMap(() => findUser(id))
        .tap((user) => logInfo(`Found user: ${user.name}`))
        .tapError((error) => logError(`Failed to find user: ${error}`));
}

// ============ Implementations ============

const consoleLogger: Logger = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`)
};

const inMemoryUserRepo: UserRepository = {
    users: new Map<number, User>([
        [1, { id: 1, name: "Alice", email: "alice@example.com" }],
        [2, { id: 2, name: "Bob", email: "bob@example.com" }]
    ]),
    async findById(id: number) {
        return this.users.get(id) || null;
    },
    async save(user: User) {
        this.users.set(user.id, user);
    }
} as UserRepository & { users: Map<number, User> };

// ============ Runtime ============

const runtime: Runtime<AppEnv> = Runtime.default
    .provideService(LoggerTag, consoleLogger)
    .provideService(UserRepoTag, inMemoryUserRepo);

// ============ Run ============

runtime.safeRunEither(getUser(1)).then((result) => {
    if (result._tag === "Right") {
        console.log("User:", result.value);
    } else {
        console.log("Error:", result.value);
    }
});
```

## Summary

| Concept | Description |
|---------|-------------|
| `R` parameter | Type-level environment requirements |
| `Tag<Id, S>` | Type-safe service identifier |
| `Has<Tag>` | Type indicating a service is available |
| `tag(id)` | Create a service tag |
| `provideService(tag, impl)` | Add a service to runtime |
| `TIO.make((env) => ...)` | Access environment in effect |

## Benefits

1. **Compile-time safety**: Missing dependencies are type errors
2. **Easy testing**: Swap implementations for mocks
3. **No magic**: Plain TypeScript, no decorators or reflection
4. **Composable**: Environments merge automatically
5. **Explicit**: Dependencies are visible in types

## Next Steps

- [Getting Started](./getting-started.md) - Quick introduction
- [Core Concepts](./core-concepts.md) - TIO fundamentals
- [Fibers](./fibers.md) - Concurrent execution

