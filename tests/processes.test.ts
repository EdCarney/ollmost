import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { elapsedMs, hasChildren, isOllmostsGroup, parsePs, spawnGroup, stopAllGroups, trackProcesses } from '../src/main/processes'
import { tempDir } from './tempDir'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Start `sh -c script`, where the script prints a background child's pid; resolves with [leader, child]. */
async function startTree(script: string) {
  const proc = spawnGroup('sh', ['-c', script])
  const child = await new Promise<number>((resolve) => proc.child.stdout!.once('data', (d) => resolve(Number(String(d).trim()))))
  return { proc, pids: [proc.child.pid!, child] }
}

const until = async (check: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!check() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20))
  return check()
}

describe('process groups', () => {
  it('stops a process and the children it started', async () => {
    const { proc, pids } = await startTree('sleep 30 & echo $!; wait')
    expect(pids.every(alive)).toBe(true)
    await proc.stop()
    expect(await until(() => !pids.some(alive))).toBe(true)
  })

  it('kills what ignores SIGTERM once the grace period is over', async () => {
    // An ignored signal stays ignored across exec, so the background sleep ignores TERM too.
    const { proc, pids } = await startTree("trap '' TERM; sleep 30 & echo $!; wait")
    const t0 = Date.now()
    await proc.stop(200)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    expect(await until(() => !pids.some(alive))).toBe(true)
  })

  it('stops what a process left behind when it exits on its own', async () => {
    const { pids } = await startTree('sleep 30 & echo $!')
    expect(await until(() => !pids.some(alive))).toBe(true)
  })

  it('stops everything before quitting', async () => {
    const a = await startTree('sleep 30 & echo $!; wait')
    const b = await startTree('sleep 30 & echo $!; wait')
    expect(hasChildren()).toBe(true)
    await stopAllGroups(500)
    expect(await until(() => ![...a.pids, ...b.pids].some(alive))).toBe(true)
    expect(hasChildren()).toBe(false)
  })

  it('reports a missing command as an error, like spawn', async () => {
    const proc = spawnGroup('ollmost-no-such-command-xyz', [])
    const err = await new Promise<Error>((resolve) => proc.child.once('error', resolve))
    expect(err.message).toMatch(/ENOENT/)
    await proc.stop() // nothing to stop
  })
})

describe('cleaning up after a crash', () => {
  const dir = tempDir('ollmost-pidfile-')
  const recorded = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as Array<{ pgid: number }>).map((r) => r.pgid)

  /** A group started the way Ollmost starts one, but not tracked: what a crashed run leaves behind. Resolves with its pids. */
  async function orphan() {
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const bg = await new Promise<number>((resolve) => child.stdout!.once('data', (d) => resolve(Number(String(d).trim()))))
    return { pgid: child.pid!, pids: [child.pid!, bg] }
  }

  it('keeps a file of the groups that are running', async () => {
    const file = join(dir, 'live.json')
    expect(await trackProcesses(file)).toBe(0)
    const { proc } = await startTree('sleep 30 & echo $!; wait')
    expect(recorded(file)).toEqual([proc.child.pid])
    await proc.stop()
    expect(recorded(file)).toEqual([])
  })

  it('stops the groups an earlier run recorded and left running', async () => {
    const left = await orphan()
    const file = join(dir, 'crashed.json')
    writeFileSync(file, JSON.stringify([{ pgid: left.pgid, startedAt: Date.now(), command: 'sh' }]))
    expect(await trackProcesses(file)).toBe(1)
    expect(await until(() => !left.pids.some(alive))).toBe(true)
    expect(recorded(file)).toEqual([])
  })

  it("leaves alone a group id that can't be Ollmost's any more", async () => {
    const other = await orphan()
    const file = join(dir, 'stale.json')
    // Recorded before this Mac started, and recorded after the processes now using that id had started.
    writeFileSync(
      file,
      JSON.stringify([
        { pgid: other.pgid, startedAt: 0, command: 'sh' },
        { pgid: other.pgid, startedAt: Date.now() + 60_000, command: 'sh' }
      ])
    )
    expect(await trackProcesses(file)).toBe(0)
    expect(other.pids.every(alive)).toBe(true)
    process.kill(-other.pgid, 'SIGKILL')
  })

  // #70: a group id is its leader's pid, and pids are reused.
  it('leaves alone a newer group that reuses a recorded id', async () => {
    const other = await orphan()
    const file = join(dir, 'reused.json')
    // Ollmost's group with this id was recorded 30 s before the group now using it started.
    writeFileSync(file, JSON.stringify([{ pgid: other.pgid, startedAt: Date.now() - 30_000, command: 'sh' }]))
    expect(await trackProcesses(file)).toBe(0)
    expect(other.pids.every(alive)).toBe(true)
    process.kill(-other.pgid, 'SIGKILL')
  })

  it('keeps the records until they are cleaned up', async () => {
    const file = join(dir, 'kept.json')
    const records = [{ pgid: 999_999, startedAt: Date.now(), command: 'sh' }]
    writeFileSync(file, JSON.stringify(records))
    const cleaning = trackProcesses(file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(records)
    expect(await cleaning).toBe(0)
    expect(recorded(file)).toEqual([])
  })

  describe("telling Ollmost's group from another with the same id", () => {
    const t = 1_700_000_000_000
    const record = { pgid: 500, startedAt: t, command: 'npx -y server' }
    const rows = (...ps: Array<[pid: number, pgid: number, startedAt: number]>) =>
      ps.map(([pid, pgid, startedAt]) => ({ pid, pgid, startedAt }))

    it('is Ollmost’s when its leader started when Ollmost recorded it', () => {
      expect(isOllmostsGroup(record, rows([500, 500, t + 800], [501, 500, t + 5_000]), 0)).toBe(true)
      expect(isOllmostsGroup(record, rows([500, 500, t - 1_000]), 0)).toBe(true)
    })

    it('isn’t when its leader is newer or older, however new its other processes', () => {
      expect(isOllmostsGroup(record, rows([500, 500, t + 60_000], [501, 500, t + 61_000]), 0)).toBe(false)
      expect(isOllmostsGroup(record, rows([500, 500, t - 60_000], [501, 500, t + 1_000]), 0)).toBe(false)
    })

    it('with its leader gone, is Ollmost’s only when its oldest process started just after the record', () => {
      expect(isOllmostsGroup(record, rows([501, 500, t + 2_000], [502, 500, t + 90_000]), 0)).toBe(true)
      expect(isOllmostsGroup(record, rows([501, 500, t + 120_000]), 0)).toBe(false)
      expect(isOllmostsGroup(record, rows([501, 500, t - 10_000]), 0)).toBe(false)
    })

    it('isn’t when recorded before the Mac started, or when nothing is in the group', () => {
      expect(isOllmostsGroup(record, rows([500, 500, t]), t + 1)).toBe(false)
      expect(isOllmostsGroup(record, rows([600, 600, t]), 0)).toBe(false)
    })

    it("reads ps's table", () => {
      expect(parsePs('  500   500      00:05\n  501   500 1-00:00:00\n\n', t)).toEqual(
        rows([500, 500, t - 5_000], [501, 500, t - 86_400_000])
      )
    })
  })

  it("reads ps's elapsed times", () => {
    expect(elapsedMs('05:07')).toBe(307_000)
    expect(elapsedMs('1:02:03')).toBe(3_723_000)
    expect(elapsedMs('2-00:00:01')).toBe(172_801_000)
  })
})
