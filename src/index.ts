import { TIO } from "./tio/tio";
import { URIO } from "./tio/aliases";
import { Runtime } from "./tio/runtime";
import { Has, tag, Tag } from "./tio/tag";
import { fold } from "./tio/util/exit";
import { failures, isInterrupted, prettyPrint } from "./tio/cause";

// ============================================================
// Service Definitions
// ============================================================

type DbResult = { result: unknown };

interface DB {
    query(sql: string): Promise<DbResult>;
}

interface Logger {
    log(s: string): void;
}

// ============================================================
// Service Tags
// ============================================================

const LoggerTag: Tag<"Logger", Logger> = tag("Logger");
const DBTag: Tag<"DB", DB> = tag("DB");

// ============================================================
// Service Implementations
// ============================================================

const logger: Logger = { log: console.log };

const db: DB = {
    query(sql: string): Promise<DbResult> {
        if (Math.random() > 0.2) {
            // the DB crashes 80% of the time
            return Promise.reject(`Query [${sql}] failed.`);
        } else {
            return Promise.resolve({ result: `Query [${sql}] was executed successfully.` });
        }
    }
};

// ============================================================
// Environment Types
// ============================================================

type HasLogger = Has<typeof LoggerTag>;
type HasDB = Has<typeof DBTag>;
type Env = HasLogger & HasDB;

// ============================================================
// Effect Helpers
// ============================================================

function log(s: string): URIO<HasLogger, void> {
    return TIO.make<HasLogger, void>((env) => env.Logger.log(s));
}

type DbError = string;

function queryDb(sql: string): TIO<HasDB, DbError, DbResult> {
    return TIO.async<HasDB, DbError, DbResult>((env, resolve, reject) => {
        env.DB.query(sql).then(resolve).catch(reject);
    });
}

// ============================================================
// Runtime
// ============================================================

const runtime: Runtime<Env> = Runtime.default.provideService(LoggerTag, logger).provideService(DBTag, db);

// ============================================================
// Example 1: Basic Query with Retry
// ============================================================

async function example1_BasicQueryWithRetry() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 1: Basic Query with Retry");
    console.log("=".repeat(60));

    const queryDbAndLogResult: TIO<Env, DbError, void> = queryDb("SELECT * FROM some_table")
        .tap((result) => log(`Query succeeded: ${JSON.stringify(result)}`))
        .tapError((error) => log(`Query failed: ${error}`))
        .retry(2)
        .map(JSON.stringify)
        .flatMap(log);

    const result = await runtime.safeRunExit(queryDbAndLogResult);
    fold(
        result,
        (error) => console.log(`Program encountered this error: ${error}`),
        (value) => console.log(`Program exited successfully with ${value}`)
    );
}

// ============================================================
// Example 2: Concurrent Fibers
// ============================================================

async function example2_ConcurrentFibers() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 2: Concurrent Fibers");
    console.log("=".repeat(60));

    const task = (name: string, ms: number) =>
        log(`[${name}] Starting...`)
            .flatMap(() => TIO.sleep(ms))
            .flatMap(() => log(`[${name}] Completed after ${ms}ms`))
            .map(() => name);

    const program = task("Task A", 100)
        .fork()
        .flatMap((fiberA) =>
            task("Task B", 50)
                .fork()
                .flatMap((fiberB) =>
                    task("Task C", 75)
                        .fork()
                        .flatMap((fiberC) =>
                            TIO.joinFiber(fiberA).flatMap((a) =>
                                TIO.joinFiber(fiberB).flatMap((b) => TIO.joinFiber(fiberC).map((c) => [a, b, c]))
                            )
                        )
                )
        );

    const start = Date.now();
    const results = await runtime.unsafeRun(program);
    const elapsed = Date.now() - start;

    console.log(`All tasks completed: ${results.join(", ")}`);
    console.log(`Total time: ${elapsed}ms (concurrent, not sequential ~225ms)`);
}

// ============================================================
// Example 3: Racing Effects
// ============================================================

async function example3_Racing() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 3: Racing Effects");
    console.log("=".repeat(60));

    const fast = log("Fast task starting").flatMap(() => TIO.sleep(50).map(() => "fast wins!"));

    const slow = log("Slow task starting").flatMap(() => TIO.sleep(200).map(() => "slow wins!"));

    const winner = await runtime.unsafeRun(TIO.raceFirst(fast, slow));
    console.log(`Winner: ${winner}`);
}

// ============================================================
// Example 4: Timeout Pattern
// ============================================================

async function example4_Timeout() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 4: Timeout Pattern");
    console.log("=".repeat(60));

    function withTimeout<R, E, A>(effect: TIO<R, E, A>, ms: number, timeoutError: E): TIO<R, E, A> {
        const timeout = TIO.sleep(ms).flatMap(() => TIO.fail(timeoutError)) as TIO<R, E, A>;
        return TIO.raceFirst(effect, timeout);
    }

    const slowOperation = log("Starting slow operation...")
        .flatMap(() => TIO.sleep(500))
        .map(() => "completed");

    const result = await runtime.safeRunEither(withTimeout(slowOperation, 100, "Operation timed out!"));

    if ("right" in result) {
        console.log(`Success: ${result.right}`);
    } else {
        console.log(`Timeout: ${result.left}`);
    }
}

// ============================================================
// Example 5: Fiber Interruption
// ============================================================

async function example5_Interruption() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 5: Fiber Interruption");
    console.log("=".repeat(60));

    const longRunning = log("Long task started")
        .flatMap(() => TIO.sleep(10000))
        .flatMap(() => log("Long task completed")); // This won't print

    const program = longRunning.fork().flatMap((fiber) =>
        TIO.sleep(100)
            .flatMap(() => log("Interrupting fiber..."))
            .flatMap(() => TIO.interruptFiber(fiber))
    );

    const exit = await runtime.unsafeRun(program);
    if (exit._tag === "Failure") {
        console.log(`Fiber exit: ${prettyPrint(exit.cause)}`);
        console.log(`Was interrupted: ${isInterrupted(exit.cause)}`);
    } else {
        console.log("Fiber completed successfully (unexpected)");
    }
}

// ============================================================
// Example 6: Error Recovery
// ============================================================

async function example6_ErrorRecovery() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 6: Error Recovery");
    console.log("=".repeat(60));

    const primary = TIO.fail("Primary source unavailable");
    const fallback1 = TIO.fail("Fallback 1 also unavailable");
    const fallback2 = TIO.succeed("Data from fallback 2");

    const resilientFetch = primary.orElse(fallback1).orElse(fallback2);

    const result = await Runtime.default.unsafeRun(resilientFetch);
    console.log(`Got: ${result}`);
}

// ============================================================
// Example 7: Resource Cleanup (Ensuring)
// ============================================================

async function example7_ResourceCleanup() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 7: Resource Cleanup");
    console.log("=".repeat(60));

    const acquireResource = log("Acquiring resource...");
    const releaseResource = log("Releasing resource (always runs)");

    const useResource = log("Using resource...")
        .flatMap(() => TIO.fail("Something went wrong during use!"))
        .flatMap(() => log("This won't print"));

    const program = acquireResource.flatMap(() => useResource.ensuring(releaseResource));

    const result = await runtime.safeRunEither(program);
    if ("left" in result) {
        console.log(`Error occurred: ${result.left}`);
    }
}

// ============================================================
// Example 8: Combining Multiple Effects
// ============================================================

async function example8_CombiningEffects() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 8: Combining Multiple Effects");
    console.log("=".repeat(60));

    const fetchUser = TIO.succeed({ id: 1, name: "Alice" }).delay(50);
    const fetchPosts = TIO.succeed([{ title: "Hello" }, { title: "World" }]).delay(75);
    const fetchSettings = TIO.succeed({ theme: "dark" }).delay(25);

    // Using zip to combine
    const combined = fetchUser.zip(fetchPosts).zip(fetchSettings);

    const start = Date.now();
    const [[user, posts], settings] = await Runtime.default.unsafeRun(combined);
    const elapsed = Date.now() - start;

    console.log(`User: ${JSON.stringify(user)}`);
    console.log(`Posts: ${JSON.stringify(posts)}`);
    console.log(`Settings: ${JSON.stringify(settings)}`);
    console.log(`Time: ${elapsed}ms (sequential: 50+75+25=150ms)`);
}

// ============================================================
// Example 9: FoldM for Exhaustive Error Handling
// ============================================================

async function example9_FoldM() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 9: FoldM for Exhaustive Error Handling");
    console.log("=".repeat(60));

    type ApiError = "not_found" | "unauthorized" | "server_error";

    const apiCall = (shouldFail: ApiError | null): TIO<unknown, ApiError, string> =>
        shouldFail ? TIO.fail(shouldFail) : TIO.succeed("Success!");

    const handleError = (error: ApiError): TIO<unknown, never, string> => {
        switch (error) {
            case "not_found":
                return TIO.succeed("Resource not found, using default");
            case "unauthorized":
                return TIO.succeed("Please log in first");
            case "server_error":
                return TIO.succeed("Server is down, try again later");
        }
    };

    const program = apiCall("not_found").foldM(handleError, (data) => TIO.succeed(`Got: ${data}`));

    const result = await Runtime.default.unsafeRun(program);
    console.log(result);
}

// ============================================================
// Example 10: Rich Error Cause Inspection
// ============================================================

async function example10_CauseInspection() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 10: Rich Error Cause Inspection");
    console.log("=".repeat(60));

    // Simulate parallel failures
    const fail1 = TIO.fail("Database connection failed");
    const fail2 = TIO.fail("Cache connection failed");

    const program = fail1.fork().flatMap((f1) =>
        fail2.fork().flatMap((f2) =>
            TIO.awaitFiber(f1).flatMap((exit1) =>
                TIO.awaitFiber(f2).map((exit2) => {
                    const allFailures: string[] = [];

                    if (exit1._tag === "Failure") {
                        allFailures.push(...failures(exit1.cause));
                    }
                    if (exit2._tag === "Failure") {
                        allFailures.push(...failures(exit2.cause));
                    }

                    return allFailures;
                })
            )
        )
    );

    const errors = await Runtime.default.unsafeRun(program);
    console.log("All errors collected:", errors);
}

// ============================================================
// Example 11: Parallel Data Fetching with TIO.all
// ============================================================

async function example11_ParallelFetching() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 11: Parallel Data Fetching with TIO.all");
    console.log("=".repeat(60));

    const fetchUserId = (id: number) => TIO.succeed({ id, name: `User ${id}` }).delay(50 + Math.random() * 50);

    const userIds = [1, 2, 3, 4, 5];
    const fetchAllUsers = TIO.all(...userIds.map(fetchUserId));

    const start = Date.now();
    const users = await Runtime.default.unsafeRun(fetchAllUsers);
    const elapsed = Date.now() - start;

    console.log(`Fetched ${users.length} users:`);
    users.forEach((u) => console.log(`  - ${JSON.stringify(u)}`));
    console.log(`Time: ${elapsed}ms (parallel, not ${userIds.length * 75}ms sequential)`);
}

// ============================================================
// Example 12: Retry with Exponential Backoff
// ============================================================

async function example12_ExponentialBackoff() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 12: Retry with Exponential Backoff");
    console.log("=".repeat(60));

    function retryWithBackoff<R, E, A>(effect: TIO<R, E, A>, maxRetries: number, baseDelayMs: number): TIO<R, E, A> {
        const loop = (attempt: number): TIO<R, E, A> =>
            effect.orElse(
                attempt >= maxRetries
                    ? effect // Last attempt, let it fail
                    : TIO.succeed(undefined)
                          .tap(() =>
                              TIO.make(() =>
                                  console.log(
                                      `  Retry ${attempt + 1}/${maxRetries}, waiting ${baseDelayMs * Math.pow(2, attempt)}ms`
                                  )
                              )
                          )
                          .flatMap(() => TIO.sleep(baseDelayMs * Math.pow(2, attempt)))
                          .flatMap(() => loop(attempt + 1))
            );
        return loop(0);
    }

    let attempts = 0;
    const flakyService = TIO.make(() => {
        attempts++;
        if (attempts < 4) {
            throw new Error(`Attempt ${attempts} failed`);
        }
        return `Success on attempt ${attempts}!`;
    });

    const result = await Runtime.default.safeRunEither(retryWithBackoff(flakyService, 5, 50));

    if ("right" in result) {
        console.log(`Result: ${result.right}`);
    } else {
        console.log(`Failed after all retries: ${result.left}`);
    }
}

// ============================================================
// Example 13: Pipeline Pattern (Data Processing)
// ============================================================

async function example13_Pipeline() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 13: Pipeline Pattern (Data Processing)");
    console.log("=".repeat(60));

    type Data = { value: number; processed: string[] };

    const fetchData = TIO.succeed<Data>({ value: 10, processed: [] }).tap(() =>
        TIO.make(() => console.log("  Step 1: Fetching data"))
    );

    const validate = (data: Data) =>
        data.value > 0
            ? TIO.succeed({ ...data, processed: [...data.processed, "validated"] })
            : TIO.fail("Invalid data: value must be positive");

    const transform = (data: Data) =>
        TIO.succeed({
            ...data,
            value: data.value * 2,
            processed: [...data.processed, "transformed"]
        }).tap(() => TIO.make(() => console.log("  Step 2: Transforming")));

    const enrich = (data: Data) =>
        TIO.succeed({
            ...data,
            value: data.value + 5,
            processed: [...data.processed, "enriched"]
        }).tap(() => TIO.make(() => console.log("  Step 3: Enriching")));

    const save = (data: Data) => TIO.succeed(data).tap(() => TIO.make(() => console.log("  Step 4: Saving")));

    const pipeline = fetchData.flatMap(validate).flatMap(transform).flatMap(enrich).flatMap(save);

    const result = await Runtime.default.unsafeRun(pipeline);
    console.log(`Final result: ${JSON.stringify(result)}`);
}

// ============================================================
// Example 14: Fiber Supervision (Background Workers)
// ============================================================

async function example14_FiberSupervision() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 14: Fiber Supervision (Background Workers)");
    console.log("=".repeat(60));

    const worker = (id: number, iterations: number): TIO<Env, never, void> => {
        const work = (i: number): TIO<Env, never, void> =>
            i >= iterations
                ? log(`  Worker ${id}: Done!`)
                : log(`  Worker ${id}: Processing item ${i + 1}/${iterations}`)
                      .flatMap(() => TIO.sleep(30))
                      .flatMap(() => work(i + 1));
        return work(0);
    };

    const program = log("Supervisor: Starting workers...")
        .flatMap(() => worker(1, 3).fork())
        .flatMap((w1) =>
            worker(2, 4)
                .fork()
                .flatMap((w2) =>
                    worker(3, 2)
                        .fork()
                        .flatMap((w3) =>
                            log("Supervisor: All workers started, waiting for completion...")
                                .flatMap(() => TIO.awaitFiber(w1))
                                .flatMap(() => TIO.awaitFiber(w2))
                                .flatMap(() => TIO.awaitFiber(w3))
                                .flatMap(() => log("Supervisor: All workers completed!"))
                        )
                )
        );

    await runtime.unsafeRun(program);
}

// ============================================================
// Example 15: Either-based Error Handling (mapBoth, absolve)
// ============================================================

async function example15_EitherPatterns() {
    console.log("\n" + "=".repeat(60));
    console.log("Example 15: Either-based Error Handling");
    console.log("=".repeat(60));

    // Using mapBoth to transform both success and error
    const effect = TIO.fail("lowercase error").mapBoth(
        (e) => e.toUpperCase(),
        (a: number) => a * 2
    );

    const result1 = await Runtime.default.safeRunEither(effect);
    console.log(`mapBoth result: ${JSON.stringify(result1)}`);

    // Using flip to swap error and success channels
    const flipped = TIO.fail("I'm now success!").flip();
    const result2 = await Runtime.default.unsafeRun(flipped);
    console.log(`flip result: ${result2}`);

    // Using fold to handle both cases with pure functions
    const handled = TIO.fail("error").fold(
        (e) => `Handled error: ${e}`,
        (a) => `Success: ${a}`
    );
    const result3 = await Runtime.default.unsafeRun(handled);
    console.log(`fold result: ${result3}`);
}

// ============================================================
// Main: Run All Examples
// ============================================================

async function main() {
    console.log("TIO Playground - Demonstrating Effect System Features");
    console.log("=".repeat(60));

    await example1_BasicQueryWithRetry();
    await example2_ConcurrentFibers();
    await example3_Racing();
    await example4_Timeout();
    await example5_Interruption();
    await example6_ErrorRecovery();
    await example7_ResourceCleanup();
    await example8_CombiningEffects();
    await example9_FoldM();
    await example10_CauseInspection();
    await example11_ParallelFetching();
    await example12_ExponentialBackoff();
    await example13_Pipeline();
    await example14_FiberSupervision();
    await example15_EitherPatterns();

    console.log("\n" + "=".repeat(60));
    console.log("All examples completed!");
    console.log("=".repeat(60));
}

main().catch(console.error);
