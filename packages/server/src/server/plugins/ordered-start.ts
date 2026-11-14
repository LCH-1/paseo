/**
 * Starts every item with at most `limit` of them loading at once, while every step a
 * caller takes after `turn()` happens in item order. `turn` frees the item's load slot
 * and resolves once every earlier item has finished (succeeded or failed); calling it
 * again is harmless. An item that never calls it is still finished in order. Every item
 * runs even when another rejects; the first rejection is rethrown at the end.
 */
export async function startInOrder<Item>(
  items: readonly Item[],
  limit: number,
  start: (item: Item, turn: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const waiting: Array<() => void> = [];
  let active = 0;
  const acquire = async (): Promise<void> => {
    if (active < Math.max(1, limit)) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const handOff = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  let previous = Promise.resolve();
  const results = await Promise.allSettled(
    items.map((item) => {
      const prior = previous;
      let finish!: () => void;
      previous = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return (async () => {
        await acquire();
        let holding = true;
        const turn = async (): Promise<void> => {
          if (holding) {
            holding = false;
            handOff();
          }
          await prior;
        };
        try {
          await start(item, turn);
        } finally {
          await turn();
          finish();
        }
      })();
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

/** Runs at most `limit` tasks at once, in the order they were submitted. */
export function createLimiter(
  limit: number,
): <Value>(task: () => Promise<Value>) => Promise<Value> {
  const waiting: Array<() => void> = [];
  let active = 0;
  return async (task) => {
    if (active < Math.max(1, limit)) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
