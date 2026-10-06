import { app } from 'electron'

/**
 * A test-only environment override: the mock servers the unit tests and the e2e run point the app at, the guard they
 * turn off, the configs they import MCP servers from, and the data folder they use. Honoured in an unpackaged build
 * only (development, the tests, the e2e run); the shipped app ignores it, so a process that can set Ollmost's
 * environment can't have the ollama.com key sent to a server of its choosing, a guard switched off, or commands of
 * its choosing offered or trusted as MCP servers, without touching the keychain or Ollmost's files (#137). Some unit
 * tests mock electron without `app` at all, hence the `?.`; a test that reaches this module mocks electron, since the
 * real package would fetch the binary.
 */
export function testOverride(
  name: string,
  packaged: boolean = !!app?.isPackaged,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return packaged ? undefined : env[name]
}
