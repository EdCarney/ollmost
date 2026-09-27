// Runs one search_files call off the main thread (see searchFiles in files.ts). A regular expression that backtracks
// badly can take seconds on one line, and nothing interrupts a regex, but a thread can be ended at the deadline.
// Plain JavaScript, loaded as text and evaluated in a worker thread: a separate bundle entry would need more of the
// build. The files are the walk's (real paths under the folder, read under the session's lock), opened here as
// openNoLinks does: no link anywhere in the path, non-blocking, a regular file only.
/* eslint-disable @typescript-eslint/no-require-imports -- evaluated as a script in the worker, where only require loads a module */
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')

const { root, files, pattern, maxBytes, maxMatches, maxLineChars, binaryProbe } = workerData
const NO_LINKS = process.platform === 'darwin' ? 0x20000000 : fs.constants.O_NOFOLLOW
const regex = new RegExp(pattern)
let matches = 0

/** A file's lines: a final newline ends the last line rather than starting an empty one. */
function splitLines(text) {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return text === '' ? [] : lines
}

for (const rel of files) {
  if (matches >= maxMatches) break
  let fd = null
  try {
    const path = `${root}/${rel}`
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NO_LINKS)
    const s = fs.fstatSync(fd)
    // Elsewhere than a Mac only the file itself is checked by open(): the folders above it are checked here.
    if (!s.isFile() || s.size > maxBytes || (process.platform !== 'darwin' && fs.realpathSync(path) !== path)) continue
    const buffer = fs.readFileSync(fd)
    // Closed before the matching, which the deadline may end without reaching finally.
    fs.closeSync(fd)
    fd = null
    if (buffer.subarray(0, binaryProbe).includes(0)) continue
    const lines = splitLines(buffer.toString('utf8'))
    const hits = []
    for (let n = 0; n < lines.length && matches + hits.length < maxMatches; n++) {
      if (!regex.test(lines[n])) continue
      const line = lines[n].length > maxLineChars ? `${lines[n].slice(0, maxLineChars)}…` : lines[n]
      hits.push(`${rel}:${n + 1}: ${line}`)
    }
    if (hits.length) {
      matches += hits.length
      parentPort.postMessage({ file: rel, lines: hits })
    }
  } catch {
    // Unreadable, or gone: not a match.
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
parentPort.postMessage({ done: true, cut: matches >= maxMatches })
