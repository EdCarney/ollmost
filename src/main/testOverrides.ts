import { app } from 'electron'

/**
 * A test-only environment override: the mock servers the unit tests and the e2e run point the app at, and the guard
 * they turn off. Honoured in an unpackaged build only (development, the tests, the e2e run); the shipped app ignores
 * it, so a process that can set Ollmost's environment can't have the ollama.com key sent to a server of its choosing,
 * or a guard switched off, without touching the keychain (#137). Outside Electron (the unit tests), `app` is undefined.
 */
export function testOverride(
  name: string,
  packaged: boolean = !!app?.isPackaged,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return packaged ? undefined : env[name]
}
