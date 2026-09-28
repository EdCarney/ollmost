import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { chosenOption, TextArea, TextField } from '@/components/ui'
import { cn } from '@/lib/format'

// Layout pieces shared by the Settings tabs.

/** Text input that saves on blur, so typing doesn't write settings on every keystroke. */
export function BlurField({
  value,
  onSave,
  multiline,
  ...rest
}: {
  value: string
  onSave: (v: string) => void
  multiline?: boolean
  placeholder?: string
  type?: string
  rows?: number
}) {
  const [local, setLocal] = useState(value)
  // The text last saved, until `value` catches up: Enter saves, and the blur after it mustn't send the same text again
  // while that save (an address probe, say) is still on its way.
  const sent = useRef<string | null>(null)
  useEffect(() => {
    setLocal(value)
    sent.current = null
  }, [value])
  const commit = () => {
    if (local === value || local === sent.current) return
    sent.current = local
    onSave(local)
  }
  return multiline ? (
    <TextArea value={local} onChange={(e) => setLocal(e.target.value)} onBlur={commit} {...rest} />
  ) : (
    <TextField
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      {...rest}
    />
  )
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line py-6 first:pt-0 last:border-0">
      <h2 className="text-[15px] font-medium">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-subtle">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  label
}: {
  value: T
  options: Array<{ value: T; label: string; icon?: ReactNode }>
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  /** Names the group for screen readers. */
  label?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex rounded-lg bg-hover p-0.5', size === 'sm' ? 'text-xs' : 'text-[13px]')}>
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-md',
            size === 'sm' ? 'px-2 py-0.5' : 'px-3 py-1',
            value === o.value ? chosenOption : 'text-muted hover:text-fg'
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}
