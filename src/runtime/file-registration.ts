import type { Runtime } from ".";

export interface RegisteredFile {
  name: string;
  bytes: Uint8Array;
}

type FileRuntime = Pick<Runtime, "registerFile" | "dropFile">;

export async function withRegisteredFiles<T>(
  runtime: FileRuntime,
  files: ReadonlyArray<RegisteredFile>,
  operation: () => Promise<T>,
  onDropError: (name: string, error: unknown) => void,
): Promise<T> {
  const registered: string[] = [];
  try {
    for (const file of files) {
      // Track before awaiting so a registration that mutates the worker and
      // then rejects is still cleaned up best-effort.
      registered.push(file.name);
      await runtime.registerFile(file.name, file.bytes);
    }
    return await operation();
  } finally {
    // Drop in reverse registration order and keep trying after a failure. A
    // cleanup error must not replace the query result or its original error.
    for (const name of registered.reverse()) {
      try {
        await runtime.dropFile(name);
      } catch (e) {
        onDropError(name, e);
      }
    }
  }
}
