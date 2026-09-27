// The Changes panel's git runs in flight, by folder key. They count as code running in the folder (the lock keeps
// Ollmost's own work apart from them), so a reply starting there would lose its tools to a refresh that ends in a
// moment: instead the reply stops the panel's runs and waits for them to end, and the panel looks again later. Kept
// apart from changes.ts so session.ts can ask without a cycle (changes.ts needs session.ts).

interface PanelRuns {
  /** Aborts every run of this generation, queued or going. */
  controller: AbortController
  /** Settles once the last run queued under this controller has ended. */
  settled: Promise<void>
}

const runs = new Map<string, PanelRuns>()
/** Stops under way, by key: a second reply on the same folder waits for the first one's. */
const stopping = new Map<string, Promise<void>>()

/** The controller a new panel run in `key`'s folder should run under, and the run it must wait for first. */
export function panelRun(key: string): { signal: AbortSignal; after: Promise<void> } {
  const current = runs.get(key) ?? { controller: new AbortController(), settled: Promise.resolve() }
  runs.set(key, current)
  return { signal: current.controller.signal, after: current.settled }
}

/** Note a panel run's promise, so a reply can wait for it. */
export function panelRunStarted(key: string, run: Promise<unknown>): void {
  const current = runs.get(key)
  if (!current) return
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  current.settled = settled
}

/** Whether a reply stopped this run's generation. */
export const panelRunStopped = (signal: AbortSignal): boolean => signal.aborted && signal.reason === STOPPED

const STOPPED = 'reply started'

/**
 * Stop the panel's runs in `key`'s folder, queued or going, and wait for them to end (a stopped run ends within
 * about a second: the runtime stops its process, then what it left). Later panel runs start afresh.
 */
export async function stopPanelRuns(key: string): Promise<void> {
  const current = runs.get(key)
  if (!current) return stopping.get(key)
  runs.delete(key)
  current.controller.abort(STOPPED)
  const done = current.settled
  stopping.set(key, done)
  try {
    await done
  } finally {
    if (stopping.get(key) === done) stopping.delete(key)
  }
}
