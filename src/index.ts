import { TIO } from "./tio/tio";
import { URIO } from "./tio/aliases";
import { Runtime } from "./tio/runtime";
import { tag, Has, Tag } from "./tio/tag";
import { fold } from "./tio/util/exit";

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

type Env = HasLogger & HasDB

const runtime: Runtime<Env> = Runtime.default
    .provideService(LoggerTag, logger)
    .provideService(DBTag, db);

function log(s: string): URIO<HasLogger, void> {
    return TIO.make<HasLogger, never, void>((env) => env.Logger.log(s));
}

type DbError = string

function queryDb(sql: string): TIO<HasDB, DbError, DbResult> {
    return new TIO<HasDB, never, DbResult>((env) => env.DB.query(sql));
}

// todo: add logging with tap and tapError when they become pure
const queryDbAndLogResult: TIO<HasDB & HasLogger, DbError, void> =
    queryDb("SELECT * FROM some_table")
        .retry(2)
        .map(JSON.stringify)
        .flatMap(log)

runtime.safeRunExit(queryDbAndLogResult)
    .then(result =>
        fold(
            result,
            (error) => console.log(`Program encountered this error: ${error}`),
            (value) => console.log(`Program exited successfully with ${value}`)
        )
    );

