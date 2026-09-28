import { memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeCitations } from '@shared/citations'
import { normalizeMath } from '@shared/mathText'
import { normalizeSpaces } from '@shared/text'
import { cn } from '@/lib/format'
import { CodeBlock } from './CodeBlock'
import { LinkCard } from './LinkCard'

interface Props {
  text: string
  /**
   * The chat this text belongs to (a reply, or one of its artifacts), or null outside a chat (a skill's instructions).
   * Required so every caller decides: the main process refuses link previews for chats with tools or files.
   */
  conversationId: string | null
  className?: string
  onOpenAsArtifact?: (code: string, lang: string | null) => void
}

function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(textOf).join('')
  return ''
}

export const Markdown = memo(function Markdown({ text, conversationId, className, onOpenAsArtifact }: Props) {
  const components: Components = {
    pre: ({ children }) => <>{children}</>,
    code: ({ className: cls, children }) => {
      const match = /language-([\w+#.-]+)/.exec(cls ?? '')
      const code = textOf(children).replace(/\n$/, '')
      // Fenced blocks have a language class or contain newlines; everything else is inline.
      if (!match && !code.includes('\n')) return <code>{children}</code>
      return <CodeBlock code={code} lang={match?.[1] ?? null} onOpenAsArtifact={onOpenAsArtifact} />
    },
    a: ({ href, children }) =>
      href ? (
        <LinkCard href={href} text={textOf(children)} conversationId={conversationId}>
          {children}
        </LinkCard>
      ) : (
        <span>{children}</span>
      ),
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table>{children}</table>
      </div>
    )
  }

  return (
    <div className={cn('prose-ollmost selectable', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {normalizeSpaces(normalizeCitations(normalizeMath(text)))}
      </ReactMarkdown>
    </div>
  )
})
