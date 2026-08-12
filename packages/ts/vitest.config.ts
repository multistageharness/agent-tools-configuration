import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Explicit imports in every test file: a reader should never have to know which globals
    // vitest injected to follow a test.
    globals: false,
  },
})
