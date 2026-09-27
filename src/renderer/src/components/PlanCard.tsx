import { Hammer } from 'lucide-react'
import { Button } from './ui'

/** Under a plan: the model can read and search but not change anything until the user starts work. */
export function PlanCard({ onStart, disabled }: { onStart: () => void; disabled?: boolean }) {
  return (
    <div
      data-testid="plan-card"
      className="flex flex-wrap items-center justify-between gap-3 rounded-ollmost border border-line bg-panel px-4 py-3 text-[13px] text-muted"
    >
      <span>This session is in plan mode: the model reads and searches, but edits and commands wait for your go-ahead.</span>
      <Button variant="primary" onClick={onStart} disabled={disabled}>
        <Hammer className="size-4" />
        Start working
      </Button>
    </div>
  )
}
