// Which projects the sidebar's Projects section lists (#128): a short list of the ones in use, like Claude desktop's,
// with ↗ (the projects page) for the rest.

/** How many projects the section lists. */
export const SIDEBAR_PROJECT_COUNT = 8
/** How many chats, and how many artifacts, an expanded project lists before "Show all". */
export const SIDEBAR_PROJECT_ITEMS = 5

interface ListedProject {
  id: string
  pinned: boolean
  /** Bumped by an edit to the project or its files, and by a message sent in one of its chats. */
  updatedAt: number
}

interface ProjectChat {
  projectId: string | null
  updatedAt: number
}

/**
 * The projects to list: pinned ones first, then the rest, each most recently active first, `count` in all; then the
 * project in view, when it isn't among them, so its row doesn't vanish while one of its chats is open. A project's
 * activity is its latest edit or its latest chat, whichever is later: a chat moved into it, or a reply finishing in it,
 * counts too.
 */
export function sidebarProjects<P extends ListedProject>(
  projects: P[],
  chats: ProjectChat[],
  viewedId: string | null,
  count = SIDEBAR_PROJECT_COUNT
): P[] {
  const latest = new Map<string, number>()
  for (const c of chats) if (c.projectId) latest.set(c.projectId, Math.max(latest.get(c.projectId) ?? 0, c.updatedAt))
  const activity = (p: P) => Math.max(p.updatedAt, latest.get(p.id) ?? 0)
  const listed = [...projects].sort((a, b) => Number(b.pinned) - Number(a.pinned) || activity(b) - activity(a)).slice(0, count)
  const viewed = viewedId && !listed.some((p) => p.id === viewedId) ? projects.find((p) => p.id === viewedId) : undefined
  return viewed ? [...listed, viewed] : listed
}
