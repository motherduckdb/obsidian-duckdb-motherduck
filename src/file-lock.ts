export class FileLock {
  private locks = new Map<string, Promise<void>>();

  async run<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.locks.set(path, next);
    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(path) === next) this.locks.delete(path);
    }
  }
}
