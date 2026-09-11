/** End broker/source renewals before destructive sandbox teardown begins. */
export class RenewalDrain {
  private closing = false;
  private readonly pending = new Set<Promise<void>>();

  run(operation: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.resolve();
    const task = Promise.resolve().then(operation);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.pending);
  }
}
