export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s |= 0; this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
  // Both of these used to end in a non-null assertion, so an empty distribution
  // returned `undefined` at runtime and got interpolated into a segment as the
  // literal string "undefined" — a profile with an empty catalog produced
  // plausible-looking messages that were silently wrong. Fail where the mistake
  // is instead.
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("Rng.pick: empty array");
    return arr[this.int(arr.length)]!;
  }
  weighted<T>(pairs: ReadonlyArray<readonly [T, number]>): T {
    if (pairs.length === 0) throw new Error("Rng.weighted: empty distribution");
    const total = pairs.reduce((a, [, w]) => a + w, 0);
    let x = this.next() * total;
    for (const [v, w] of pairs) { if ((x -= w) < 0) return v; }
    return pairs[pairs.length - 1]![0];
  }
  /**
   * Inter-arrival time (seconds) for a Poisson process of mean `rate` events/sec.
   * Exponentially distributed (mean 1/rate) — feed this between sends and the
   * arrivals form a realistic feed cadence instead of a flat burst.
   */
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }
}
