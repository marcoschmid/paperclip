import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import postgres from "postgres";

const scenario = process.env.PAPERCLIP_POSTGRES_DISCONNECT_SCENARIO;
const resultPrefix = "PAPERCLIP_POSTGRES_DISCONNECT_RESULT=";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, label, timeoutMs = 5_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const int32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};

const message = (type, payload = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from(type, "latin1"), int32(4 + payload.length), payload]);

const readyForQuery = message("Z", Buffer.from("I", "latin1"));
const handshake = Buffer.concat([message("R", int32(0)), readyForQuery]);
const emptyQueryResult = Buffer.concat([
  message("C", Buffer.from("SELECT 1\0", "latin1")),
  readyForQuery,
]);

class FakeSocket extends EventEmitter {
  readyState = "open";
  host = "127.0.0.1";
  port = 5432;
  responding = true;
  queryWrites = 0;
  #greeted = false;

  write(_chunk, callback) {
    if (this.responding) {
      const reply = this.#greeted ? emptyQueryResult : handshake;
      if (this.#greeted) this.queryWrites += 1;
      this.#greeted = true;
      setImmediate(() => {
        if (this.readyState === "open") this.emit("data", reply);
      });
    }
    callback?.();
    return true;
  }

  end() {
    this.readyState = "closed";
    return this;
  }

  destroy() {
    this.readyState = "closed";
    return this;
  }

  pause() {
    return this;
  }

  resume() {
    return this;
  }

  setKeepAlive() {
    return this;
  }

  remoteClose() {
    this.readyState = "closed";
    this.emit("close", false);
  }
}

async function drainImmediates(count = 6) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function shutdown(sql) {
  let timer;
  await Promise.race([
    sql.end({ timeout: 0 }).catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 1_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function postgresOptions(socket, onclose) {
  return {
    max: 1,
    fetch_types: false,
    prepare: false,
    connect_timeout: 2,
    idle_timeout: null,
    max_lifetime: null,
    no_subscribe: true,
    onclose,
    socket,
  };
}

async function queuedWriteDuringReconnect() {
  const firstSocket = new FakeSocket();
  const secondSocketRequested = deferred();
  const secondSocketReady = deferred();
  const firstClose = deferred();
  let socketCalls = 0;
  let secondSocket;

  const sql = postgres(
    postgresOptions(
      () => {
        socketCalls += 1;
        if (socketCalls === 1) return firstSocket;
        secondSocket = new FakeSocket();
        secondSocketRequested.resolve();
        return secondSocketReady.promise.then(() => secondSocket);
      },
      () => firstClose.resolve(),
    ),
  );

  try {
    await sql`select 1`;
    const reserved = await sql.reserve();

    firstSocket.responding = false;
    firstSocket.remoteClose();
    await withTimeout(firstClose.promise, "first socket close");

    const reconnectOutcomePromise = sql`select 2`.then(
      () => "RESOLVED",
      (error) => error?.code ?? "UNKNOWN",
    );
    await withTimeout(secondSocketRequested.promise, "reconnect socket request");

    // connect() has reset `terminated`, but awaits the replacement socket. A
    // stale reserved handle can therefore reach nextWrite() while socket=null.
    const staleCode = await withTimeout(
      reserved`select 3`.then(
        () => "RESOLVED",
        (error) => error?.code ?? "UNKNOWN",
      ),
      "queued write rejection",
    );
    assert.equal(staleCode, "CONNECTION_CLOSED");

    secondSocketReady.resolve();
    const reconnectOutcome = await withTimeout(
      reconnectOutcomePromise,
      "reconnect query outcome",
    );
    assert.equal(reconnectOutcome, "CONNECTION_CLOSED");
    await sql`select 4`;

    return { staleCode, reconnectOutcome, recovered: true };
  } finally {
    secondSocketReady.resolve();
    await shutdown(sql);
  }
}

async function staleTransactionAfterReconnect() {
  const sockets = [];
  const firstClose = deferred();
  const transactionReady = deferred();
  const releaseTransactionCallback = deferred();
  const staleQueryOutcome = deferred();

  const sql = postgres(
    postgresOptions(
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      () => firstClose.resolve(),
    ),
  );

  try {
    const transactionOutcomePromise = sql.begin(async (txSql) => {
      transactionReady.resolve(txSql);
      await releaseTransactionCallback.promise;
      const outcome = await txSql`select 'must not escape transaction'`.then(
        () => "RESOLVED",
        (error) => error?.code ?? "UNKNOWN",
      );
      staleQueryOutcome.resolve(outcome);
    }).then(
      () => "RESOLVED",
      (error) => error?.code ?? "UNKNOWN",
    );

    await withTimeout(transactionReady.promise, "transaction callback");
    const firstSocket = sockets[0];
    assert.ok(firstSocket);
    firstSocket.responding = false;
    firstSocket.remoteClose();
    await withTimeout(firstClose.promise, "transaction socket close");

    const transactionOutcome = await withTimeout(
      transactionOutcomePromise,
      "transaction close rejection",
    );
    assert.equal(transactionOutcome, "CONNECTION_CLOSED");

    await sql`select 'pool reconnect'`;
    const replacementSocket = sockets[1];
    assert.ok(replacementSocket);
    const queryWritesBeforeStaleHandle = replacementSocket.queryWrites;

    releaseTransactionCallback.resolve();
    const staleCode = await withTimeout(staleQueryOutcome.promise, "stale transaction query");
    await drainImmediates();

    assert.equal(staleCode, "CONNECTION_CLOSED");
    assert.equal(replacementSocket.queryWrites, queryWritesBeforeStaleHandle);

    return {
      transactionOutcome,
      staleCode,
      replacementQueryWrites: replacementSocket.queryWrites,
      queryWritesBeforeStaleHandle,
    };
  } finally {
    releaseTransactionCallback.resolve();
    await shutdown(sql);
  }
}

async function realIdleTransactionTimeout() {
  const databaseUrl = process.env.PAPERCLIP_POSTGRES_DISCONNECT_DATABASE_URL;
  assert.ok(databaseUrl, "missing child-only database URL");

  const sql = postgres(databaseUrl, {
    max: 1,
    fetch_types: false,
    max_lifetime: null,
    connection: {
      application_name: "paperclip-idle-transaction-child",
      idle_in_transaction_session_timeout: 250,
    },
  });
  const transactionReady = deferred();
  const releaseTransactionCallback = deferred();
  const staleQueryOutcome = deferred();

  try {
    await sql.unsafe("drop table if exists postgres_disconnect_regression_probe");
    await sql.unsafe(
      "create table postgres_disconnect_regression_probe (id integer primary key)",
    );

    const transactionOutcomePromise = sql.begin(async (txSql) => {
      await txSql.unsafe(
        "insert into postgres_disconnect_regression_probe (id) values (1)",
      );
      transactionReady.resolve(txSql);
      await releaseTransactionCallback.promise;
      const outcome = await txSql`select 'must stay closed'`.then(
        () => "RESOLVED",
        (error) => error?.code ?? "UNKNOWN",
      );
      staleQueryOutcome.resolve(outcome);
    }).then(
      () => "RESOLVED",
      (error) => error?.code ?? "UNKNOWN",
    );

    await withTimeout(transactionReady.promise, "real transaction idle state");
    const transactionOutcome = await withTimeout(
      transactionOutcomePromise,
      "idle transaction timeout",
    );
    assert.equal(transactionOutcome, "CONNECTION_CLOSED");

    await sql`select 'pool recovered'`;
    releaseTransactionCallback.resolve();
    const staleCode = await withTimeout(staleQueryOutcome.promise, "real stale transaction query");
    assert.equal(staleCode, "CONNECTION_CLOSED");

    const rows = await sql.unsafe(
      "select count(*)::int as count from postgres_disconnect_regression_probe",
    );
    assert.equal(Number(rows[0]?.count ?? -1), 0);

    return { transactionOutcome, staleCode, rolledBackRows: Number(rows[0]?.count ?? -1) };
  } finally {
    releaseTransactionCallback.resolve();
    await sql.unsafe("drop table if exists postgres_disconnect_regression_probe").catch(() => {});
    await shutdown(sql);
  }
}

const scenarios = {
  "queued-write-during-reconnect": queuedWriteDuringReconnect,
  "stale-transaction-after-reconnect": staleTransactionAfterReconnect,
  "real-idle-transaction-timeout": realIdleTransactionTimeout,
};

try {
  assert.ok(scenario && scenario in scenarios, `unknown regression scenario: ${scenario}`);
  const result = await scenarios[scenario]();
  process.stdout.write(`${resultPrefix}${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
