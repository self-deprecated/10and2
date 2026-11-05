// The SQL the store needs, over either of the brain's two homes: `node:sqlite` on Lattice, a Durable Object's own
// SQLite in the cloud. Only what `Store` uses: statements with positional parameters, and transactions.

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

export interface SqlDb {
  /** One or more statements without parameters. */
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Runs `fn` in one transaction: all of it commits, or none of it does. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** The subset of `node:sqlite`'s `DatabaseSync` used here. */
type NodeDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
};

export function nodeSql(db: NodeDatabase): SqlDb {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => db.close(),
  };
}

/** The subset of a Durable Object's `ctx.storage` used here (`@cloudflare/workers-types`' `DurableObjectStorage`). */
export type DurableStorage = {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(fn: () => T): T;
};

/**
 * A Durable Object's SQLite. It refuses `BEGIN`/`COMMIT` and journal pragmas (it manages both itself), so those never
 * reach it: transactions go through `transactionSync`, and the store asks for WAL only on Node.
 */
export function durableSql(storage: DurableStorage): SqlDb {
  const all = (sql: string, params: SqlValue[]) => storage.sql.exec(sql, ...params).toArray();
  return {
    exec: (sql) => void storage.sql.exec(sql).toArray(),
    prepare: (sql) => ({
      run: (...params) => {
        all(sql, params);
        return { changes: Number(storage.sql.exec("SELECT changes() AS n").toArray()[0]?.n ?? 0) };
      },
      get: (...params) => all(sql, params)[0],
      all: (...params) => all(sql, params),
    }),
    transaction: (fn) => storage.transactionSync(fn),
    close: () => {},
  };
}
