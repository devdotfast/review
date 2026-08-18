export class AsyncQueue<Value> implements AsyncIterable<Value> {
  readonly #values: Value[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<Value>): void;
  }> = [];
  #closed = false;

  push(value: Value): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.#waiters.push({ resolve }));
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}
