import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Every date this extension writes is in the user's own timezone, so the
    // tests that assert one need a timezone of their own or they would pass or
    // fail by where the machine running them happens to be. America/Los_Angeles
    // is UTC-7 in August, which is the offset that produced the bug these tests
    // exist for: an evening run whose UTC instant falls on the next day.
    env: { TZ: 'America/Los_Angeles' },
  },
});
