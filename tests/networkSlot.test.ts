import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { holdNetwork } from '../src/main/runner/sandbox'

// The sandbox manager has one network config for every run (#79): runs with the same network rules hold it together,
// and a run with other rules waits its turn. The manager is a fake here; nothing runs in the sandbox.

const rules = (allowedDomains: string[], network: Partial<SandboxRuntimeConfig['network']> = {}): SandboxRuntimeConfig => ({
  network: { allowedDomains, deniedDomains: [], ...network },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] }
})
const A = rules(['a.test'])
const B = rules(['b.test'])
const C = rules(['c.test'])

let sb: { updateConfig: Mock<(cfg: SandboxRuntimeConfig) => void> }
beforeEach(() => {
  sb = { updateConfig: vi.fn() }
})

/** Every release a hold resolved to, so the cleanup can release what a test didn't (one that failed half-way). */
const taken: Array<() => void> = []
const hold = (policy: SandboxRuntimeConfig, signal?: AbortSignal) => {
  const held = holdNetwork(sb, policy, signal)
  held.then(
    (release) => taken.push(release),
    () => undefined
  )
  return held
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Whether a hold has resolved yet, once everything already due has run. */
const state = (held: Promise<unknown>) =>
  Promise.race([
    held.then(
      () => 'held',
      () => 'rejected'
    ),
    tick().then(() => 'waiting')
  ])

let unused = 0
afterEach(async () => {
  // Release everything the test took, and whatever each release let in.
  for (let release = taken.pop(); release; release = taken.pop()) {
    release()
    await tick()
  }
  // The slot is free: rules no test uses are set at once. The manager is left on them, so each test's first hold sets
  // its own rules.
  const probe = { updateConfig: vi.fn() }
  const free = holdNetwork(probe, rules([`unused-${++unused}.test`]))
  expect(await state(free)).toBe('held')
  expect(probe.updateConfig).toHaveBeenCalledTimes(1)
  ;(await free)()
})

describe("the sandbox's network rules, shared by concurrent runs", () => {
  it('lets runs with the same rules hold them together, setting them once', async () => {
    await hold(A)
    expect(await state(hold(A))).toBe('held')
    expect(sb.updateConfig.mock.calls).toEqual([[A]])
  })

  it('counts the same domains in any order as the same rules, and allowLocalBinding unset as off', async () => {
    await hold(rules(['a.test', 'b.test'], { deniedDomains: ['x.test', 'y.test'] }))
    expect(await state(hold(rules(['b.test', 'a.test'], { deniedDomains: ['y.test', 'x.test'], allowLocalBinding: false })))).toBe('held')
    expect(await state(hold(rules(['a.test', 'b.test'], { deniedDomains: ['x.test', 'y.test'], allowLocalBinding: true })))).toBe('waiting')
    expect(sb.updateConfig).toHaveBeenCalledTimes(1)
  })

  it('makes a run with other rules wait until every run holding the current ones has released', async () => {
    const a = await hold(A)
    const b = await hold(A)
    const c = hold(C)
    expect(await state(c)).toBe('waiting')
    a()
    expect(await state(c)).toBe('waiting')
    b()
    expect(await state(c)).toBe('held')
    expect(sb.updateConfig.mock.calls).toEqual([[A], [C]])
  })

  it('once other rules are held, lets runs with those join at once and makes runs with the first rules wait', async () => {
    const a = await hold(A)
    const c = hold(C)
    a()
    await c
    expect(await state(hold(C))).toBe('held')
    expect(await state(hold(A))).toBe('waiting')
    expect(sb.updateConfig.mock.calls).toEqual([[A], [C]])
  })

  it('lets everyone waiting with the next rules in together, ahead of other rules queued between them', async () => {
    const a = await hold(A)
    const c1 = hold(C)
    const b = hold(B)
    const c2 = hold(C)
    a()
    expect([await state(c1), await state(b), await state(c2)]).toEqual(['held', 'waiting', 'held'])
    expect(sb.updateConfig.mock.calls).toEqual([[A], [C]])
  })

  it('queues a run behind those waiting even when its rules are held, so other rules get their turn', async () => {
    const a = await hold(A)
    const b = hold(B)
    const a2 = hold(A)
    expect(await state(a2)).toBe('waiting')
    a()
    expect(await state(b)).toBe('held')
    expect(await state(a2)).toBe('waiting')
    ;(await b)()
    expect(await state(a2)).toBe('held')
    expect(sb.updateConfig.mock.calls).toEqual([[A], [B], [A]])
  })

  it('takes a run that is stopped while waiting out of line, rejecting with the reason, without holding up later runs', async () => {
    const a = await hold(A)
    const stop = new AbortController()
    const b = hold(B, stop.signal)
    expect(await state(b)).toBe('waiting')
    const reason = new Error('Stopped')
    stop.abort(reason)
    await expect(b).rejects.toBe(reason)
    // Nobody waits now: a run with the held rules joins at once, and one with other rules is next.
    const a2 = await hold(A)
    const c = hold(C)
    a()
    a2()
    expect(await state(c)).toBe('held')
    expect(sb.updateConfig.mock.calls).toEqual([[A], [C]])
  })

  it('lets in a run waiting with the held rules once the run ahead of it in line is stopped', async () => {
    await hold(A)
    const stop = new AbortController()
    const b = hold(B, stop.signal)
    const a2 = hold(A)
    expect(await state(a2)).toBe('waiting')
    stop.abort(new Error('Stopped'))
    await expect(b).rejects.toThrow('Stopped')
    expect(await state(a2)).toBe('held')
    expect(sb.updateConfig.mock.calls).toEqual([[A]])
  })

  it('holds nothing and sets nothing for a run already stopped', async () => {
    const reason = new Error('Stopped')
    await expect(hold(A, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(sb.updateConfig).not.toHaveBeenCalled()
    expect(await state(hold(C))).toBe('held')
  })

  it("does nothing when a run releases twice: the second doesn't free another run's hold", async () => {
    const a = await hold(A)
    const a2 = await hold(A)
    const c = hold(C)
    a()
    a()
    expect(await state(c)).toBe('waiting')
    a2()
    expect(await state(c)).toBe('held')
  })
})
