import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { childEnv } from '../env'
import { findPython } from './python'

// A run's process group is stopped when it ends, but code can leave it: fork, setsid(), let go of its output. Such a
// process outlives the run, Stop and Ollmost, and nothing ties it to the run once launchd adopts it (#73). Its sandbox
// does, though: a process can't leave its sandbox, and only a chat's own code may write that chat's folders. So Ollmost
// asks macOS (sandbox_check) which of the user's processes are in a chat's sandbox, and stops them. When it does is
// lock.ts's business.

const run = promisify(execFile)

/**
 * Stops every process of the user's that Ollmost's sandbox runs for one of the folders given as arguments, and prints
 * {"stopped": n, "left": [pids still running]}. That's a process that is sandboxed and may write the folder, but may
 * neither write the folder holding it nor delete the folder itself. Ollmost's policy allows only the workspace (and a
 * chat's environment), and pins it (see policyFor), while other sandboxes differ: macOS agents and browser helpers may
 * write the per-user temp folder, a sandboxed app the user opened the folder in may delete it. Each is stopped
 * (SIGSTOP) first, so none can fork or exit while the rest are found, and so its pid can't be reused: a stopped
 * process that no longer matches had its pid reused just before, and is let go. Then all are killed. If anything goes
 * wrong, a timeout's SIGTERM included, every process it stopped is let go.
 */
const REAPER = String.raw`
import ctypes, json, os, signal, sys, time

def terminated(*_):
    sys.exit(1)
signal.signal(signal.SIGTERM, terminated)

lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
check = lib.sandbox_check
check.restype = ctypes.c_int
# Only the fixed arguments are declared: the path is variadic, which Apple silicon passes differently.
check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
listpids = lib.proc_listpids
listpids.restype = ctypes.c_int
listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
PROC_UID_ONLY, FILTER_PATH, NO_REPORT = 4, 1, 0x40000000
folders = [(ctypes.c_char_p(os.fsencode(f)), ctypes.c_char_p(os.fsencode(os.path.dirname(f)))) for f in sys.argv[1:]]
me = os.getpid()

def pids():
    size = listpids(PROC_UID_ONLY, os.getuid(), None, 0)
    buf = (ctypes.c_int * (max(size, 0) // 4 + 256))()
    size = listpids(PROC_UID_ONLY, os.getuid(), buf, ctypes.sizeof(buf))
    return [p for p in buf[: max(size, 0) // 4] if p > 0 and p != me]

def allowed(pid, op, path):
    return check(pid, op, FILTER_PATH | NO_REPORT, path) == 0

def ollmosts(pid):
    if check(pid, None, 0) != 1:
        return False
    # The folders mostly share a parent, and most sandboxes that may write one may write the parent: ask that first.
    parents = {}
    for f, parent in folders:
        if parent.value not in parents:
            parents[parent.value] = allowed(pid, b'file-write-data', parent)
        if not parents[parent.value] and allowed(pid, b'file-write-data', f) and not allowed(pid, b'file-write-unlink', f):
            return True
    return False

def send(pid, sig):
    try:
        os.kill(pid, sig)
        return True
    except OSError:
        return False

held = set()
try:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        found = [p for p in pids() if p not in held and ollmosts(p)]
        if not found:
            break
        for p in found:
            if send(p, signal.SIGSTOP):
                if ollmosts(p):
                    held.add(p)
                else:
                    send(p, signal.SIGCONT)
except BaseException:
    for p in held:
        send(p, signal.SIGCONT)
    raise
for p in held:
    send(p, signal.SIGKILL)
left = []
for _ in range(40):
    left = [p for p in pids() if ollmosts(p)]
    if not left:
        break
    time.sleep(0.025)
print(json.dumps({'stopped': len(held), 'left': left}))
`

/**
 * Stop every process whose sandbox is Ollmost's for one of these folders (a chat's workspace or Python environment):
 * code from the chats they belong to. Each folder must be one only Ollmost's policy pins (those, or a session's scratch
 * under runner/sessions), never one Ollmost doesn't own, like the user's folder a session works in: sandbox-runtime
 * denies writing .git/hooks (and .bashrc, .mcp.json and more) under the working directory of the app that builds a
 * sandbox, which pins that folder, so another app's sandbox there, such as Claude Code's in the repo it runs in, would
 * match and be killed (#80). Returns how many were stopped, and
 * which of the folders were checked: a process can only be matched against a folder that exists, so a missing one (or
 * one that isn't a real folder) isn't. Throws if a process is still running afterwards. On Linux the sandbox
 * (bubblewrap, in its own process namespace) takes every process with it when the run ends, so there's nothing to do.
 */
export async function reap(folders: string[]): Promise<{ stopped: number; checked: string[] }> {
  if (process.platform !== 'darwin') return { stopped: 0, checked: folders }
  const found = await Promise.all(
    folders.map(async (f) => ((await lstat(f).catch(() => null))?.isDirectory() ? { f, real: await realpath(f).catch(() => null) } : null))
  )
  const existing = found.filter((x): x is { f: string; real: string } => !!x?.real)
  if (!existing.length) return { stopped: 0, checked: [] }
  const python = await findPython()
  if (!python) throw new Error("Python 3 wasn't found, so Ollmost couldn't check for code still running.")
  // -I: none of the user's PYTHON* settings or site-packages; -S -B: no site module, no .pyc files written.
  const { stdout } = await run(python.path, ['-I', '-S', '-B', '-c', REAPER, ...existing.map((x) => x.real)], {
    env: await childEnv(),
    timeout: 20_000
  })
  const { stopped, left } = JSON.parse(stdout) as { stopped: number; left: number[] }
  if (left.length) throw new Error(`Code from this chat is still running (process ${left.join(', ')}) and couldn't be stopped.`)
  return { stopped, checked: existing.map((x) => x.f) }
}
