// Keep node:test integration suites separate from Vitest's pure-unit suite.
export default { test: { include: ["tests/*.vitest.test.mjs"], testTimeout: 60000 } };
