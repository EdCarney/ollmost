import { reportError, useApp } from '@/stores/app'
import { api } from './api'

/**
 * Start a code session in a folder: `root` when given (a recent folder, so no dialog), else the one the user picks.
 * Nothing happens when the dialog is cancelled.
 */
export async function openFolder(root?: string): Promise<void> {
  try {
    // A session starts with the model new chats would use; it can be changed in the session's composer.
    const { draftModel, draftThink } = useApp.getState()
    if (!draftModel) throw new Error('No model to start a session with. Check that Ollama is running and has a model.')
    const folder = root ?? (await api.code.pickFolder())
    if (!folder) return
    const session = await api.code.create({ root: folder, model: draftModel, think: draftThink })
    useApp.getState().upsertConversation(session)
    useApp.getState().navigate({ name: 'code', id: session.id })
  } catch (err) {
    reportError(err)
  }
}

/** A folder's own name, the last part of its path. */
export const folderName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

/** A path as shown to the user, with the home folder shortened to ~. For display only, never for path logic. */
export const displayPath = (path: string, home: string | null): string =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
