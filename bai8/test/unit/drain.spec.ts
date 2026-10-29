import { drainDelays } from '../../src/drain';

describe('drainDelays', () => {
  it('returns nothing for no connections', () => {
    expect(drainDelays(0, 30_000)).toEqual([]);
  });

  it('spreads 2,000 connections across the whole window instead of closing them at once', () => {
    const delays = drainDelays(2000, 30_000);
    expect(delays).toHaveLength(2000);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThan(30_000);

    // At most ~67 reconnects in any given second (2000 / 30), never a spike of 2,000.
    const perSecond = new Map<number, number>();
    for (const d of delays)
      perSecond.set(Math.floor(d / 1000), (perSecond.get(Math.floor(d / 1000)) ?? 0) + 1);
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(Math.ceil(2000 / 30) + 1);
  });

  it('puts each connection in its own slot (deterministic with a fixed random)', () => {
    expect(drainDelays(4, 1000, () => 0)).toEqual([0, 250, 500, 750]);
    expect(drainDelays(4, 1000, () => 0.999)).toEqual([249, 499, 749, 999]);
  });
});
