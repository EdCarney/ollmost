import * as Dialog from '@radix-ui/react-dialog'
import * as Dropdown from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import * as RTooltip from '@radix-ui/react-tooltip'
import { Check, ChevronDown, ChevronRight, ChevronUp, LoaderCircle, X } from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { cn } from '@/lib/format'

// ---- Buttons --------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 disabled:opacity-40',
  secondary: 'bg-panel text-fg border border-line hover:bg-hover disabled:opacity-50',
  ghost: 'text-muted hover:text-fg hover:bg-hover disabled:opacity-40',
  danger: 'bg-danger text-danger-fg hover:brightness-110 disabled:opacity-50'
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }
>(function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-ollmost font-medium transition-[background,filter,color] whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {loading && <LoaderCircle className="size-4 animate-spin" />}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md'; active?: boolean; tooltip?: boolean }
>(function IconButton({ label, size = 'md', active, tooltip = true, className, children, ...rest }, ref) {
  const button = (
    <button
      ref={ref}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center rounded-lg transition-colors shrink-0',
        size === 'sm' ? 'size-7' : 'size-8',
        active ? 'bg-hover text-fg' : 'text-muted hover:text-fg hover:bg-hover',
        'disabled:opacity-40 disabled:pointer-events-none',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button
})

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn('size-4 animate-spin text-subtle', className)} />
}

// ---- Tooltip --------------------------------------------------------------

export function Tooltip({
  content,
  children,
  side = 'top'
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-md bg-fg px-2 py-1 text-xs text-canvas shadow-md select-none"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

export const TooltipProvider = RTooltip.Provider

// ---- Menus ----------------------------------------------------------------

// A floating panel's look, without padding: a submenu or a popover hands its spacing to the sections inside it, and
// cn() doesn't merge classes, so a p-0 added after surface's p-1 would lose to it (Tailwind emits p-1 later).
const panel = 'z-50 min-w-[200px] rounded-ollmost border border-line bg-panel text-sm text-fg shadow-[0_8px_30px_rgba(0,0,0,0.12)]'
const surface = `${panel} p-1`
const item =
  'flex items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-hover data-[disabled]:opacity-40'

export const Menu = Dropdown.Root
export const MenuTrigger = Dropdown.Trigger

export function MenuContent({
  children,
  align = 'start',
  side,
  className
}: {
  children: ReactNode
  align?: 'start' | 'end' | 'center'
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content align={align} side={side} sideOffset={6} className={cn(surface, className)}>
        {children}
      </Dropdown.Content>
    </Dropdown.Portal>
  )
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
  icon
}: {
  children: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  icon?: ReactNode
}) {
  return (
    <Dropdown.Item disabled={disabled} onSelect={onSelect} className={cn(item, danger && 'text-danger')}>
      {icon && <span className="flex size-4 items-center justify-center text-muted">{icon}</span>}
      {children}
    </Dropdown.Item>
  )
}

export function MenuCheckItem({
  children,
  checked,
  onCheckedChange,
  description
}: {
  children: ReactNode
  checked: boolean
  onCheckedChange: (v: boolean) => void
  description?: string
}) {
  return (
    <Dropdown.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
      className={cn(item, 'items-start')}
    >
      <span className="mt-0.5 flex size-4 items-center justify-center">
        <Dropdown.ItemIndicator>
          <Check className="size-4 text-accent" />
        </Dropdown.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description && <span className="block truncate text-xs text-subtle">{description}</span>}
      </span>
    </Dropdown.CheckboxItem>
  )
}

/**
 * A submenu that fits the window: its list scrolls when it's taller than the height Radix says is free (moved up
 * or down to fit, 8 px from the window's edges), a fade and a chevron mark whichever edge hides more, it's no
 * wider than 440 px or the room beside its trigger (so a long description truncates instead of widening every
 * row), and `footer` (an action like "Manage skills…") stays put below the list.
 */
export function MenuSub({
  label,
  icon,
  children,
  footer
}: {
  label: ReactNode
  icon?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Dropdown.Sub>
      <Dropdown.SubTrigger className={cn(item, 'data-[state=open]:bg-hover')}>
        {icon && <span className="flex size-4 items-center justify-center text-muted">{icon}</span>}
        <span className="flex-1">{label}</span>
        <ChevronRight className="size-4 text-subtle" />
      </Dropdown.SubTrigger>
      <Dropdown.Portal>
        <Dropdown.SubContent
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            panel,
            'flex max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[min(440px,var(--radix-dropdown-menu-content-available-width))] flex-col'
          )}
        >
          <MenuScroll>{children}</MenuScroll>
          {footer && <div className="shrink-0 border-t border-line p-1">{footer}</div>}
        </Dropdown.SubContent>
      </Dropdown.Portal>
    </Dropdown.Sub>
  )
}

/** A menu's scrolling list, with a cue at each edge that hides more items. */
function MenuScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ above: false, below: false })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const above = el.scrollTop > 1
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1
      setMore((m) => (m.above === above && m.below === below ? m : { above, below }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const watch = new ResizeObserver(update)
    watch.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      watch.disconnect()
    }
  }, [])
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto p-1">
        {children}
      </div>
      {more.above && <MoreCue edge="top" />}
      {more.below && <MoreCue edge="bottom" />}
    </div>
  )
}

const MoreCue = ({ edge }: { edge: 'top' | 'bottom' }) => (
  <div
    data-scroll-cue={edge}
    className={cn(
      'pointer-events-none absolute inset-x-0 flex h-7 justify-center from-panel to-transparent',
      edge === 'top' ? 'top-0 items-start bg-linear-to-b pt-0.5' : 'bottom-0 items-end bg-linear-to-t pb-0.5'
    )}
  >
    {edge === 'top' ? <ChevronUp className="size-3.5 text-subtle" /> : <ChevronDown className="size-3.5 text-subtle" />}
  </div>
)

export const MenuSeparator = () => <Dropdown.Separator className="my-1 h-px bg-line" />
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <Dropdown.Label className="px-2 pb-1 pt-1.5 text-xs font-medium text-subtle">{children}</Dropdown.Label>
)

// ---- Popover --------------------------------------------------------------

export const PopoverRoot = Popover.Root
export const PopoverTrigger = Popover.Trigger
export const PopoverAnchor = Popover.Anchor

export function PopoverContent({
  children,
  className,
  align = 'start',
  side = 'bottom',
  onOpenAutoFocus
}: {
  children: ReactNode
  className?: string
  align?: 'start' | 'end' | 'center'
  side?: 'top' | 'bottom'
  onOpenAutoFocus?: (e: Event) => void
}) {
  return (
    <Popover.Portal>
      <Popover.Content
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={12}
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn(panel, className)}
      >
        {children}
      </Popover.Content>
    </Popover.Portal>
  )
}

// ---- Dialog ---------------------------------------------------------------

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-ollmost-lg border border-line bg-panel text-fg shadow-2xl',
            wide ? 'max-w-3xl' : 'max-w-lg'
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
              {description && <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close" size="sm" tooltip={false}>
                <X className="size-4" />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ---- Form controls --------------------------------------------------------

const field =
  'w-full rounded-ollmost border border-line bg-canvas px-3 text-sm text-fg placeholder:text-subtle outline-none focus:border-line-strong focus:ring-2 focus:ring-accent-soft'

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextField(
  { className, ...rest },
  ref
) {
  return <input ref={ref} className={cn(field, 'h-9', className)} {...rest} />
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref
) {
  return <textarea ref={ref} className={cn(field, 'resize-none py-2 leading-relaxed', className)} {...rest} />
})

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-strong'
      )}
    >
      {/* On, the knob takes the accent's text colour so it stays visible on light accents (Mocha, Dracula). */}
      <span
        className={cn(
          'inline-block size-4 rounded-full shadow transition-transform',
          checked ? 'translate-x-[18px] bg-accent-fg' : 'translate-x-0.5 bg-white'
        )}
      />
    </button>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="block text-xs text-subtle">{hint}</span>}
    </label>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'warn'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'neutral' && 'bg-hover text-muted',
        tone === 'warn' && 'bg-[color-mix(in_srgb,var(--o-danger)_14%,transparent)] text-danger',
        className
      )}
    >
      {children}
    </span>
  )
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-hover text-muted">{icon}</div>
      <div className="text-base font-medium">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  )
}
