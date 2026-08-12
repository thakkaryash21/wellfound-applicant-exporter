import { describe, it, expect } from 'vitest';
import { sample, sampleInt, sleep } from '../src/lib/jitter.js';

describe('sample', () => {
  it('stays inside the requested bounds across many draws', () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = sample(2500, 7000);
      expect(value).toBeGreaterThanOrEqual(2500);
      expect(value).toBeLessThanOrEqual(7000);
    }
  });

  it('clusters below the midpoint, unlike a uniform draw', () => {
    const mid = (2500 + 7000) / 2;
    const draws = Array.from({ length: 4000 }, () => sample(2500, 7000));
    const below = draws.filter((d) => d < mid).length;
    expect(below / draws.length).toBeGreaterThan(0.55);
    expect(below / draws.length).toBeLessThan(0.8);
  });

  it('spreads the middle half of draws across at least a quarter of the range', () => {
    const draws = Array.from({ length: 8000 }, () => sample(2500, 7000)).sort((a, b) => a - b);
    const iqr = draws[Math.floor(draws.length * 0.75)] - draws[Math.floor(draws.length * 0.25)];
    expect(iqr / (7000 - 2500)).toBeGreaterThan(0.25);
  });

  it('does not pile draws onto the upper bound', () => {
    const draws = Array.from({ length: 8000 }, () => sample(2500, 7000));
    const atMax = draws.filter((d) => d === 7000).length;
    expect(atMax / draws.length).toBeLessThan(0.01);
  });

  it('returns the bound when min equals max', () => {
    expect(sample(1000, 1000)).toBe(1000);
  });
});

// T4: untested until now, and not imported by this file at all. It decides how
// many downloads pass before a reading break, and `rand` is injected straight
// into it.
describe('sampleInt', () => {
  it('stays within the inclusive bounds even when rand returns its maximum', () => {
    // Math.random() never returns 1, but `rand` is a seam and nothing obliges an
    // injected source to honour that. Unclamped this returned max + 1.
    expect(sampleInt([8, 12], () => 1)).toBe(12);
    expect(sampleInt([8, 12], () => 0.999999999)).toBeLessThanOrEqual(12);
  });

  it('covers every value in the range, both bounds included', () => {
    expect(sampleInt([8, 12], () => 0)).toBe(8);
    const seen = new Set(Array.from({ length: 4000 }, () => sampleInt([8, 12])));
    expect([...seen].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12]);
    for (const value of seen) {
      expect(value).toBeGreaterThanOrEqual(8);
      expect(value).toBeLessThanOrEqual(12);
    }
  });
});

describe('sleep', () => {
  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleep(5000, controller.signal);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('cuts a long sleep short when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await sleep(5000, controller.signal);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
