import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FileLock } from "../src/file-lock";

test("FileLock serializes work for the same file", async () => {
  const lock = new FileLock();
  const events: string[] = [];
  let releaseFirst!: () => void;

  const first = lock.run("note.md", async () => {
    events.push("first:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
    return 1;
  });

  const second = lock.run("note.md", async () => {
    events.push("second:start");
    return 2;
  });

  await flushMicrotasks();
  assert.deepEqual(events, ["first:start"]);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("FileLock allows different files to run concurrently", async () => {
  const lock = new FileLock();
  const events: string[] = [];
  let releaseFirst!: () => void;

  const first = lock.run("a.md", async () => {
    events.push("a:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    events.push("a:end");
  });

  const second = lock.run("b.md", async () => {
    events.push("b:start");
  });

  await second;
  assert.deepEqual(events, ["a:start", "b:start"]);
  releaseFirst();
  await first;
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
