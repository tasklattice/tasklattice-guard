/** Tracks accepted work, including child jobs added while earlier work drains. */
export class PendingWork {
  private readonly jobs = new Set<Promise<unknown>>();
  track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    return job;
  }
  async drain(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
}

type Entry = { task: () => Promise<void>; running: boolean; again: boolean; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

/** One queued job per identity. A trigger during execution schedules one fresh
 * pass, at the tail of the queue, so newer generations are never lost and busy
 * identities cannot starve the rest. All passes share the concurrency ceiling.
 */
export class KeyedWorkQueue<K> {
  private readonly entries = new Map<K, Entry>();
  private readonly queue: K[] = [];
  private active = 0;
  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid work concurrency");
  }
  run(key: K, task: () => Promise<void>): Promise<void> {
    const found = this.entries.get(key);
    if (found) {
      found.task = task;
      if (found.running) found.again = true;
      return found.promise;
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.entries.set(key, { task, running: false, again: false, promise, resolve, reject });
    this.queue.push(key);
    this.pump();
    return promise;
  }
  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const key = this.queue.shift()!;
      const entry = this.entries.get(key)!;
      entry.running = true;
      entry.again = false;
      this.active++;
      void Promise.resolve().then(() => entry.task()).then(
        () => this.finish(key, entry), error => this.finish(key, entry, { error }),
      );
    }
  }
  private finish(key: K, entry: Entry, failure?: { error: unknown }): void {
    this.active--;
    entry.running = false;
    if (entry.again) this.queue.push(key);
    else {
      this.entries.delete(key);
      if (failure) entry.reject(failure.error); else entry.resolve();
    }
    this.pump();
  }
}
