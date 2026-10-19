/**
 * What crypto plugins share: a wallet per card, funded from one treasury.
 */

/**
 * Runs work one piece at a time, in order. Treasury sends go through one, so
 * two cards at once don't pick the same coins or the same nonce.
 */
export function oneAtATime(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
}

/**
 * What's gone out of a card's wallet: nothing until it has sent anything
 * (so a funding payment that isn't seen yet doesn't read as spent), then
 * whatever of its limit isn't still there, fees included.
 */
export function walletSpent(limit: bigint, balance: bigint, hasSent: boolean): bigint {
  if (!hasSent) return 0n;
  return balance >= limit ? 0n : limit - balance;
}
