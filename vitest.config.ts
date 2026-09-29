import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // setup.ts runs in each test file's own context, so its afterAll removes the folders that file made.
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'] }
})
