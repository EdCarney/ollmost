import { describe, expect, it } from 'vitest'
import { diffCounts } from '@shared/diff'

describe('diffCounts', () => {
  it('counts added and removed lines in a hunk', () => {
    const diff = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,6 @@
 context line
-removed line
+added line 1
+added line 2
+added line 3
 context line
`
    expect(diffCounts(diff)).toEqual({ added: 3, removed: 1 })
  })

  it('counts a new file (--- /dev/null) as all additions', () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,3 @@
+line1
+line2
+line3
`
    expect(diffCounts(diff)).toEqual({ added: 3, removed: 0 })
  })

  it('counts a removed line of dashes inside a hunk as removed, not as a header', () => {
    const diff = `diff --git a/rule.md b/rule.md
index 111..222 100644
--- a/rule.md
+++ b/rule.md
@@ -1,2 +1,1 @@
 keep this
-----
`
    expect(diffCounts(diff)).toEqual({ added: 0, removed: 1 })
  })

  it('ignores the "\\ No newline at end of file" marker', () => {
    const diff = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`
    expect(diffCounts(diff)).toEqual({ added: 1, removed: 1 })
  })

  it('returns 0/0 for an empty string', () => {
    expect(diffCounts('')).toEqual({ added: 0, removed: 0 })
  })
})
