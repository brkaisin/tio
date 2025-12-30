import { TIO } from "./tio/tio";
import { URIO } from "./tio/aliases";
import { Runtime } from "./tio/runtime";
import { Has, tag, Tag } from "./tio/tag";
import { fold } from "./tio/util/exit";

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
    await example6_ErrorRecovery();
    await example7_ResourceCleanup();
    await example8_CombiningEffects();
    await example9_FoldM();
    await example11_ParallelFetching();
    await example12_ExponentialBackoff();
    await example13_Pipeline();
    await example15_EitherPatterns();

    console.log("\n" + "=".repeat(60));
    console.log("All examples completed!");
    console.log("=".repeat(60));
}

main().catch(console.error);
