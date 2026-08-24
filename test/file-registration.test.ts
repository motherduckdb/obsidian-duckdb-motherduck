import { strict as assert } from "node:assert";
import { test } from "node:test";
import { withRegisteredFiles } from "../src/runtime/file-registration";

function file(name: string) {
  return { name, bytes: new Uint8Array([1]) };
}

test("withRegisteredFiles releases buffers after a successful operation", async () => {
  const events: string[] = [];
  const runtime = {
    async registerFile(name: string) {
      events.push(`register:${name}`);
    },
    async dropFile(name: string) {
      events.push(`drop:${name}`);
    },
  };

  const result = await withRegisteredFiles(
    runtime,
    [file("a.csv"), file("b.csv")],
    async () => {
      events.push("query");
      return 42;
    },
    () => assert.fail("cleanup should not fail"),
  );

  assert.equal(result, 42);
  assert.deepEqual(events, [
    "register:a.csv",
    "register:b.csv",
    "query",
    "drop:b.csv",
    "drop:a.csv",
  ]);
});

test("withRegisteredFiles releases registered buffers after errors", async () => {
  const dropped: string[] = [];
  const runtime = {
    async registerFile() {},
    async dropFile(name: string) {
      dropped.push(name);
    },
  };
  const queryError = new Error("query failed");

  await assert.rejects(
    withRegisteredFiles(
      runtime,
      [file("a.csv"), file("b.csv")],
      async () => {
        throw queryError;
      },
      () => assert.fail("cleanup should not fail"),
    ),
    (error) => error === queryError,
  );
  assert.deepEqual(dropped, ["b.csv", "a.csv"]);
});

test("withRegisteredFiles cleans up after a registration error", async () => {
  const dropped: string[] = [];
  const registerError = new Error("register failed");
  const runtime = {
    async registerFile(name: string) {
      if (name === "b.csv") throw registerError;
    },
    async dropFile(name: string) {
      dropped.push(name);
    },
  };

  await assert.rejects(
    withRegisteredFiles(
      runtime,
      [file("a.csv"), file("b.csv")],
      async () => assert.fail("query should not run"),
      () => assert.fail("cleanup should not fail"),
    ),
    (error) => error === registerError,
  );
  assert.deepEqual(dropped, ["b.csv", "a.csv"]);
});

test("withRegisteredFiles does not mask the query result when cleanup fails", async () => {
  const cleanupErrors: Array<{ name: string; error: unknown }> = [];
  const dropError = new Error("drop failed");
  const runtime = {
    async registerFile() {},
    async dropFile() {
      throw dropError;
    },
  };

  const result = await withRegisteredFiles(
    runtime,
    [file("a.csv")],
    async () => "ok",
    (name, error) => cleanupErrors.push({ name, error }),
  );

  assert.equal(result, "ok");
  assert.deepEqual(cleanupErrors, [{ name: "a.csv", error: dropError }]);
});
