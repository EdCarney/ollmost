import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { describe, expect, it } from 'vitest'
import { escapeStrayDollars, normalizeMath } from '@shared/mathText'

/** The inline and display math remark-math finds in a reply once it's normalized, as Markdown.tsx renders it. */
function mathIn(text: string): { inline: string[]; display: string[] } {
  const html = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, remarkMath] }, normalizeMath(text)))
  const found = (cls: string) => [...html.matchAll(new RegExp(`<code class="language-math ${cls}">([^<]*)</code>`, 'g'))].map((m) => m[1])
  return { inline: found('math-inline'), display: found('math-display') }
}

/** The text a reply shows, tags stripped. */
function shown(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, remarkMath] }, normalizeMath(text))).replace(
    /<[^>]+>/g,
    ''
  )
}

describe('a $ before a number is money, not math', () => {
  it('two amounts in one paragraph stay text', () => {
    const text = '$4.1trn of debt through 2028; $420bn next year'
    expect(normalizeMath(text)).toBe('\\$4.1trn of debt through 2028; \\$420bn next year')
    expect(mathIn(text)).toEqual({ inline: [], display: [] })
    expect(shown(text)).toBe(text)
  })

  it('bold amounts keep their bold', () => {
    const text = 'Some **$4.1trn** of debt matures, and **$420bn** of it next year.'
    expect(mathIn(text).inline).toEqual([])
    const html = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, remarkMath] }, normalizeMath(text)))
    expect(html).toContain('<strong>$4.1trn</strong>')
    expect(html).toContain('<strong>$420bn</strong>')
  })

  it('whole-dollar amounts, ranges and amounts in a table stay text', () => {
    for (const text of ['costs $5 and $10', 'from $5-$10 a month', 'US$5 or US$10', 'between $ 5 and $10'])
      expect(mathIn(text).inline, text).toEqual([])
    expect(shown('costs $5 and $10')).toBe('costs $5 and $10')
    const table = '| Plan | Price |\n| --- | --- |\n| Basic | $5 |\n| Pro | $10 |'
    expect(mathIn(table).inline).toEqual([])
  })

  it('math written with dollars is still math', () => {
    expect(normalizeMath('$x^2$')).toBe('$x^2$')
    expect(mathIn('$x^2$').inline).toEqual(['x^2'])
    expect(mathIn('where $a$ and $b$ are sides').inline).toEqual(['a', 'b'])
    expect(mathIn('the $5$-cycle').inline).toEqual(['5'])
  })

  it('math next to money: only the math is math', () => {
    expect(mathIn('It costs $5, or $n \\cdot p$ for $n$ items.').inline).toEqual(['n \\cdot p', 'n'])
    expect(mathIn('It costs $5 (or $x$ each) and $10 in all.').inline).toEqual(['x'])
  })

  it('math written with \\( \\) is math, after normalizeMath', () => {
    expect(normalizeMath('\\(2^n\\)')).toBe('$2^n$')
    expect(mathIn('\\(2^n\\)').inline).toEqual(['2^n'])
    // Beside prices: the prices were escaped before \( \) became dollars.
    expect(mathIn('costs $5 and \\(x^2\\) and $10').inline).toEqual(['x^2'])
    // One-line $$ math (as \[ \] becomes) is math too; remark-math only sets it apart when it has lines of its own.
    expect(mathIn('\\[\\sum_i x_i\\]').inline).toEqual(['\\sum_i x_i'])
  })

  it('leaves code spans and fenced code untouched', () => {
    expect(escapeStrayDollars('`echo $HOME $PATH`')).toBe('`echo $HOME $PATH`')
    expect(escapeStrayDollars('Run ``echo `x` $HOME`` for $5')).toBe('Run ``echo `x` $HOME`` for \\$5')
    const fenced = 'It costs $5:\n\n```bash\necho $HOME $PATH\n```\n\nand $10 after.'
    expect(escapeStrayDollars(fenced)).toBe('It costs \\$5:\n\n```bash\necho $HOME $PATH\n```\n\nand \\$10 after.')
    const nested = '1. Run:\n   ~~~~\n   echo $A $B\n   ~~~\n   ~~~~\n2. Pay $5'
    expect(escapeStrayDollars(nested)).toBe('1. Run:\n   ~~~~\n   echo $A $B\n   ~~~\n   ~~~~\n2. Pay \\$5')
    // A fence still open (a reply streaming) is code to the end.
    expect(escapeStrayDollars('```sh\necho $HOME $PATH')).toBe('```sh\necho $HOME $PATH')
    // A price before a code span holding a $ doesn't pair with it.
    expect(escapeStrayDollars('It costs $5; see `a$b`')).toBe('It costs \\$5; see `a$b`')
  })

  it('leaves $$ display math untouched', () => {
    expect(escapeStrayDollars('$$E = mc^2$$')).toBe('$$E = mc^2$$')
    expect(mathIn('$$E = mc^2$$').inline).toEqual(['E = mc^2'])
    const block = 'Energy costs $5:\n\n$$\nE = mc^2\n$$\n\nor $10.'
    expect(escapeStrayDollars(block)).toBe('Energy costs \\$5:\n\n$$\nE = mc^2\n$$\n\nor \\$10.')
    expect(mathIn(block).display).toEqual(['E = mc^2'])
  })

  it('takes \\$ as a literal dollar', () => {
    expect(escapeStrayDollars('\\$5')).toBe('\\$5')
    expect(shown('\\$5')).toBe('$5')
    expect(escapeStrayDollars('\\$5 and \\$10 and $x$')).toBe('\\$5 and \\$10 and $x$')
    expect(mathIn('\\$5 and \\$10 and $x$').inline).toEqual(['x'])
  })

  it('math never runs across a paragraph or into the next list item', () => {
    expect(escapeStrayDollars('Pay $5\n\nor 3$ later')).toBe('Pay \\$5\n\nor 3\\$ later')
    expect(mathIn('- a $b\n- c$ and $y$').inline).toEqual(['y'])
    // Within a paragraph, a line break doesn't end it.
    expect(mathIn('so $a +\nb$ holds').inline).toEqual(['a +\nb'])
  })

  it('leaves a bare link’s $ alone', () => {
    expect(escapeStrayDollars('See https://example.com/?price=$5 for $10')).toBe('See https://example.com/?price=$5 for \\$10')
  })

  it('leaves text without a $ as it is', () => {
    const text = 'Nothing to see: `code`, **bold**, \\(x\\).'
    expect(escapeStrayDollars(text)).toBe(text)
  })
})
