// Whether a chat's live thinking opens by itself. It does until the reader closes it while the model is thinking, and
// again once they open it while it thinks; toggling a finished round's thinking says nothing about live ones.

/** How many chats' choices are kept: chat ids are never reused, so a deleted chat's is only dropped as it ages out. */
export const CLOSED_THINKING_KEPT = 500

/** `closed` (the chats whose live thinking starts closed, oldest choice first) after the reader toggles it in `chatId`. */
export function afterLiveToggle(closed: readonly string[], chatId: string, open: boolean): string[] {
  const rest = closed.filter((id) => id !== chatId)
  return open ? rest : [...rest, chatId].slice(-CLOSED_THINKING_KEPT)
}
