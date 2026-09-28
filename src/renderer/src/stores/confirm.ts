import { create } from 'zustand'

export interface ConfirmRequest {
  title: string
  /** One line per thing that would be lost. */
  body: string[]
  /** The destructive button's label; Cancel is always the other one. */
  confirmLabel: string
}

interface ConfirmState {
  request: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  /** Ask the user before a destructive action; resolves true for the destructive button, false for Cancel. */
  ask: (request: ConfirmRequest) => Promise<boolean>
  answer: (ok: boolean) => void
}

/** A single pending confirmation, rendered by the one `ConfirmDialog` mounted near the app root. Used only where an
 *  action loses something: the history an Edit or a Retry would drop (see historyLoss), or what removing an endpoint
 *  deletes (see removalText). Keep it that narrow. */
export const useConfirm = create<ConfirmState>((set, get) => ({
  request: null,
  ask: (request) =>
    new Promise((resolve) => {
      // A request already waiting (e.g. a chat switched away from before its own confirm resolved) is abandoned,
      // not left hanging: it reads as a Cancel.
      get().request?.resolve(false)
      set({ request: { ...request, resolve } })
    }),
  answer: (ok) => {
    get().request?.resolve(ok)
    set({ request: null })
  }
}))
