import { useConfirm } from '@/stores/confirm'
import { Button, Modal } from './ui'

/** Renders the one pending confirm from stores/confirm, if any; mounted once near the app root. */
export function ConfirmDialog() {
  const request = useConfirm((s) => s.request)
  const answer = useConfirm((s) => s.answer)

  return (
    <Modal
      open={!!request}
      onOpenChange={(open) => !open && answer(false)}
      title={request?.title ?? ''}
      description={request?.body.join(' ')}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => answer(true)}>
            {request?.confirmLabel}
          </Button>
        </>
      }
    />
  )
}
