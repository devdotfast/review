export function createAsyncLimiter(limit: number) {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  return async function limitTask<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        void task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            queue.shift()?.();
          });
      };
      if (active < max) run();
      else queue.push(run);
    });
  };
}
