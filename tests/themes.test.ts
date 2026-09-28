import { describe, expect, it } from 'vitest'
import { composite, contrast, flatten, parseColor, readableOn, toHex } from '@shared/color'
import { BUILTIN_THEMES, textOn, usesDark } from '@shared/themes'
import { PALETTE_KEYS, type Palette } from '@shared/types'

describe('colour maths', () => {
  it('parses hex and rgb() forms', () => {
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseColor('#0969DA')).toEqual({ r: 9, g: 105, b: 218, a: 1 })
    expect(parseColor('#d1d9e0b3')?.a).toBeCloseTo(0.7, 2)
    expect(parseColor('rgba(20, 20, 19, 0.055)')).toEqual({ r: 20, g: 20, b: 19, a: 0.055 })
    expect(parseColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 })
    expect(parseColor('tomato')).toBeNull()
  })

  it('matches the WCAG reference ratios', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2)
    expect(contrast('#FFFFFF', '#FFFFFF')).toBe(1)
  })

  it('composites translucent colours over the surface they sit on', () => {
    expect(toHex(composite('rgba(0, 0, 0, 0.5)', '#FFFFFF'))).toBe('#808080')
    expect(flatten('#FF0000', '#000000')).toBe('#ff0000')
    // A faint border is judged as drawn, not as its opaque source colour.
    expect(contrast('rgba(0, 0, 0, 0.1)', '#FFFFFF')).toBeLessThan(1.3)
  })

  it('picks the more readable text colour', () => {
    expect(readableOn('#FFD60A', ['#FFFFFF', '#000000'])).toBe('#000000')
    expect(readableOn('#B00020', ['#FFFFFF', '#000000'])).toBe('#FFFFFF')
  })
})

/**
 * The legibility floor every built-in theme has to clear, in both palettes. Ratios are WCAG 2
 * contrast, measured after compositing translucent tokens over the surface they're drawn on.
 */
const FLOOR = {
  body: 7, // replies are read on the canvas, so body text gets AAA there
  text: 4.5, // body text on other surfaces, and secondary text anywhere (AA)
  ui: 3, // hints, links (always underlined), status colours, button labels, syntax colours
  comment: 2.5, // code comments are dimmed on purpose
  surface: 1.04, // sidebar, your messages and code blocks must stand apart from the canvas
  line: 1.2 // borders must be visible on the canvas
}

type Check = { what: string; ratio: number; floor: number }

function checks(p: Palette, dark: boolean): Check[] {
  const on = (fg: keyof Palette, bg: keyof Palette, floor: number): Check => ({
    what: `${fg} on ${bg}`,
    ratio: contrast(p[fg], p[bg], p.canvas),
    floor
  })
  const selection = flatten(p.accentSoft, p.canvas)
  // The warning Badge: danger text on a 14% danger tint (color-mix in ui/index.tsx).
  const d = parseColor(p.danger)!
  const dangerTint = flatten(`rgba(${d.r}, ${d.g}, ${d.b}, 0.14)`, p.canvas)
  return [
    on('fg', 'canvas', FLOOR.body),
    ...(['sidebar', 'panel', 'bubble', 'code'] as const).map((s) => on('fg', s, FLOOR.text)),
    ...(['canvas', 'sidebar', 'panel', 'bubble'] as const).map((s) => on('muted', s, FLOOR.text)),
    ...(['canvas', 'sidebar', 'panel'] as const).map((s) => on('subtle', s, FLOOR.ui)),
    ...(['accent', 'danger', 'success', 'warn'] as const).flatMap((c) => [on(c, 'canvas', FLOOR.ui), on(c, 'panel', FLOOR.ui)]),
    on('accentFg', 'accent', FLOOR.ui),
    { what: 'text on danger', ratio: contrast(textOn(p.danger, p, dark), p.danger), floor: FLOOR.ui },
    { what: 'accent on accentSoft', ratio: contrast(p.accent, selection), floor: FLOOR.ui },
    { what: 'danger on its tint', ratio: contrast(p.danger, dangerTint), floor: FLOOR.ui },
    { what: 'fg on selection', ratio: contrast(p.fg, selection), floor: FLOOR.text },
    // The chosen option in a row of options (ui's `chosenOption`) is an accent chip on a hover-tinted track,
    // on a page's canvas or a dialog's panel.
    ...(['canvas', 'panel'] as const).map((s) => ({
      what: `chosen option on its track (on ${s})`,
      ratio: contrast(p.accent, flatten(p.hover, p[s])),
      floor: FLOOR.ui
    })),
    ...(['synKeyword', 'synString', 'synFunction', 'synConstant', 'synPunctuation'] as const).map((s) => on(s, 'code', FLOOR.ui)),
    on('synComment', 'code', FLOOR.comment),
    ...(['sidebar', 'bubble', 'code'] as const).map((s) => on(s, 'canvas', FLOOR.surface)),
    on('line', 'canvas', FLOOR.line)
  ]
}

describe.each(BUILTIN_THEMES.map((t) => [t.name, t] as const))('%s theme', (_name, theme) => {
  const variants = theme.only ? [theme.only] : (['light', 'dark'] as const)

  it.each(variants)('%s palette sets every token to a colour', (v) => {
    for (const key of PALETTE_KEYS) expect(parseColor(theme[v][key]), `${v}.${key}`).not.toBeNull()
  })

  it.each(variants)('%s palette is legible everywhere', (v) => {
    const failures = checks(theme[v], v === 'dark')
      .filter((c) => c.ratio < c.floor)
      .map((c) => `${c.what}: ${c.ratio.toFixed(2)} < ${c.floor}`)
    expect(failures.join('\n')).toBe('')
  })
})

describe('built-in themes', () => {
  it('have unique ids and names', () => {
    expect(new Set(BUILTIN_THEMES.map((t) => t.id)).size).toBe(BUILTIN_THEMES.length)
    expect(new Set(BUILTIN_THEMES.map((t) => t.name)).size).toBe(BUILTIN_THEMES.length)
  })

  it('single-palette themes ignore the mode; others follow it', () => {
    const hack = BUILTIN_THEMES.find((t) => t.id === 'hack')!
    const clay = BUILTIN_THEMES.find((t) => t.id === 'claude')!
    expect(usesDark(hack, 'light', false)).toBe(true)
    expect(usesDark(clay, 'light', true)).toBe(false)
    expect(usesDark(clay, 'dark', false)).toBe(true)
    expect(usesDark(clay, 'system', true)).toBe(true)
    expect(usesDark(clay, 'system', false)).toBe(false)
  })
})
