import { afterAll } from 'vitest'
import { removeTempDirs } from './tempDir'

// Registered before the test file's own hooks, so it runs after them (vitest runs afterAll hooks last-in, first-out):
// what a file starts, such as servers and child processes, is closed before the folders they use are removed.
// A file whose tests are all skipped runs no hooks at all, so one that can be skipped whole (tests/code-sandbox.test.ts,
// off a Mac) makes its folders in beforeAll, not while it loads.
afterAll(removeTempDirs)
