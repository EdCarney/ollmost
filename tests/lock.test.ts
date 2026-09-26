import { basename } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The lock that keeps Ollmost's work in a chat's folders and the chat's code apart (#71, #73, #76), with the check for
// leftover code (a macOS sandbox query, reaper.ts) replaced by a mock.

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }))
const reap = vi.fn()
vi.mock('../src/main/runner/reaper', () => ({ reap: (folders: string[]) => reap(folders) }))

type Lock = typeof import('../src/main/runner/lock')
type Workspace = import('../src/main/runner/workspace').Workspace
let lock: Lock
let chatVenvDir: (id: string) => string
beforeEach(async () => {
  vi.resetModules()
  lock = await import('../src/main/runner/lock')
  chatVenvDir = (await import('../src/main/runner/python')).chatVenvDir
  reap.mockReset()
  reap.mockImplementation(async (folders: string[]) => ({ stopped: 0, checked: folders }))
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
/** A chat's workspace at `root`, as workspaceFor makes it. */
const ws = (root: string): Workspace => ({ id: basename(root), root, owned: true, key: root, folders: [root, chatVenvDir(basename(root))] })
/** A code session's workspace on the user's folder `root`: checked by its own scratch and environment, never the root. */
const session = (id: string, root: string): Workspace => ({
  id,
  root,
  owned: false,
  key: root,
  folders: [`/runner/sessions/${id}`, chatVenvDir(id)]
})

describe("the lock on a chat's folders", () => {
  it('does the work after stopping leftovers, and lets no code start until the work is done', async () => {
    const order: string[] = []
    reap.mockImplementation(async (folders: string[]) => {
      order.push('check')
      return { stopped: 0, checked: folders }
    })
    let release = () => {}
    const work = lock.quiesce(ws('/w/a'), async () => {
      order.push('work')
      await new Promise<void>((resolve) => (release = resolve))
      order.push('work done')
    })
    await tick()
    const starting = lock.codeStarting(ws('/w/a')).then(() => order.push('code starts'))
    await tick()
    expect(order).toEqual(['check', 'work'])
    release()
    await Promise.all([work, starting])
    expect(order).toEqual(['check', 'work', 'work done', 'code starts'])
  })

  it('checks both folders a chat’s code may write: its workspace and its Python environment', async () => {
    await lock.quiesce(ws('/w/chat-1'), async () => undefined)
    expect(reap).toHaveBeenCalledWith(['/w/chat-1', chatVenvDir('chat-1')])
  })

  it('refuses while code runs; a run’s end checks, and the next work needs no check until code runs again', async () => {
    await lock.codeStarting(ws('/w/b'))
    await expect(lock.quiesce(ws('/w/b'), async () => 'x')).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded(ws('/w/b'))
    expect(reap).toHaveBeenCalledTimes(1)
    expect(await lock.quiesce(ws('/w/b'), async () => 'x')).toBe('x')
    expect(reap).toHaveBeenCalledTimes(1)
    await lock.codeStarting(ws('/w/b'))
    await lock.codeEnded(ws('/w/b'))
    expect(reap).toHaveBeenCalledTimes(2)
  })

  it('refuses work that waited behind other work while a run queued before it started', async () => {
    let release = () => {}
    const first = lock.quiesce(ws('/w/c'), () => new Promise<void>((resolve) => (release = resolve)))
    await tick()
    const starting = lock.codeStarting(ws('/w/c'))
    const second = lock.quiesce(ws('/w/c'), async () => 'ran')
    release()
    await Promise.all([first, starting])
    await expect(second).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded(ws('/w/c'))
  })

  it('never lets queued work and a queued run overlap, whichever goes first', async () => {
    const events: string[] = []
    let release = () => {}
    const first = lock.quiesce(ws('/w/c2'), () => new Promise<void>((resolve) => (release = resolve)))
    await tick()
    const second = lock.quiesce(ws('/w/c2'), async () => {
      events.push('work')
      await tick()
      events.push('work done')
    })
    const starting = lock.codeStarting(ws('/w/c2')).then(() => events.push('code starts'))
    release()
    await Promise.all([first, starting, second.catch(() => events.push('work refused'))])
    expect([
      ['work', 'work done', 'code starts'],
      ['code starts', 'work refused']
    ]).toContainEqual(events)
    await lock.codeEnded(ws('/w/c2'))
  })

  it('keeps a failed check on record, doing no work, and checks again next time', async () => {
    await lock.codeStarting(ws('/w/d'))
    reap.mockRejectedValueOnce(new Error('no Python'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await lock.codeEnded(ws('/w/d'))
    warn.mockRestore()
    expect(lock.codeMayBeRunning()).toBe(true)
    reap.mockRejectedValueOnce(new Error('no Python'))
    const work = vi.fn(async () => undefined)
    await expect(lock.quiesce(ws('/w/d'), work)).rejects.toThrow('no Python')
    expect(work).not.toHaveBeenCalled()
    await lock.quiesce(ws('/w/d'), work)
    expect(work).toHaveBeenCalledTimes(1)
    expect(lock.codeMayBeRunning()).toBe(false)
  })

  it('counts a workspace as checked only when its first folder was', async () => {
    reap.mockImplementation(async () => ({ stopped: 0, checked: [chatVenvDir('e')] }))
    await lock.quiesce(ws('/w/e'), async () => undefined)
    await lock.quiesce(ws('/w/e'), async () => undefined)
    expect(reap).toHaveBeenCalledTimes(2)
  })

  // #78: a code session's root is the user's folder; its leftovers are known by Ollmost's own folders for it.
  it("checks a code session by its own scratch and environment, never the user's folder", async () => {
    await lock.quiesce(session('s1', '/Users/me/repo'), async () => undefined)
    expect(reap).toHaveBeenCalledWith(['/runner/sessions/s1', chatVenvDir('s1')])
  })

  it('makes two sessions on one folder take turns, each with leftovers of its own to stop', async () => {
    const a = session('a', '/Users/me/repo')
    const b = session('b', '/Users/me/repo')
    await lock.codeStarting(a)
    await expect(lock.quiesce(b, async () => 'x')).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded(a)
    expect(reap).toHaveBeenLastCalledWith(a.folders)
    // a's end settled a, not b: b's leftovers are still to be checked, once.
    await lock.quiesce(b, async () => undefined)
    expect(reap).toHaveBeenLastCalledWith(b.folders)
    expect(reap).toHaveBeenCalledTimes(2)
    await lock.quiesce(a, async () => undefined)
    await lock.quiesce(b, async () => undefined)
    expect(reap).toHaveBeenCalledTimes(2)
  })

  it('checks a workspace only once its last run has ended, not while another run of its own goes on', async () => {
    const w = ws('/w/h')
    await lock.codeStarting(w)
    await lock.codeStarting(w)
    await lock.codeEnded(w)
    expect(reap).not.toHaveBeenCalled()
    await expect(lock.quiesce(w, async () => 'x')).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded(w)
    expect(reap).toHaveBeenCalledTimes(1)
    expect(await lock.quiesce(w, async () => 'x')).toBe('x')
  })

  it("stops what a session's run left even while another session's run on the same folder goes on", async () => {
    const a = session('a2', '/Users/me/repo')
    const b = session('b2', '/Users/me/repo')
    await lock.codeStarting(a)
    await lock.codeStarting(b)
    await lock.codeEnded(a)
    expect(reap).toHaveBeenCalledTimes(1)
    expect(reap).toHaveBeenLastCalledWith(a.folders)
    await expect(lock.quiesce(a, async () => 'x')).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded(b)
    expect(reap).toHaveBeenLastCalledWith(b.folders)
    expect(await lock.quiesce(a, async () => 'x')).toBe('x')
    expect(reap).toHaveBeenCalledTimes(2)
  })

  it('sweeps skip a chat whose code is running; deleting every environment waits for none', async () => {
    await lock.codeStarting(ws('/w/f'))
    const quiet: string[][] = []
    const roots = (q: Workspace[]) => q.map((w) => w.root)
    await lock.quiesceEvery([ws('/w/f'), ws('/w/g')], { skipRunning: true, work: async (q) => void quiet.push(roots(q)) })
    expect(quiet).toEqual([['/w/g']])
    expect(reap).toHaveBeenLastCalledWith(['/w/g', chatVenvDir('g')])
    await expect(lock.quiesceEvery([ws('/w/f'), ws('/w/g')], { work: async () => undefined })).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded(ws('/w/f'))
    await lock.quiesceEvery([ws('/w/f'), ws('/w/g')], { work: async (q) => void quiet.push(roots(q)) })
    expect(quiet.at(-1)).toEqual(['/w/f', '/w/g'])
  })
})
