import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { BUILTIN_THEMES, usesDark } from '@shared/themes'
import type { Palette, Settings, ThemeDef } from '@shared/types'
import { withPreview } from '@shared/settingsPreview'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { applyTheme, onSystemThemeChange, systemIsDark } from './applyTheme'

/** The OS light/dark setting, re-rendering when it changes. */
export function useSystemDark(): boolean {
  return useSyncExternalStore(onSystemThemeChange, systemIsDark)
}

/** The appearance on screen: the saved settings with the command palette's preview, if any, laid over. */
export function useAppearance(): Settings['appearance'] | null {
  const settings = useApp((s) => s.settings)
  const preview = useApp((s) => s.previewSettings)
  return useMemo(() => (settings ? withPreview(settings, preview).appearance : null), [settings, preview])
}

/** The theme on screen (the editor's live preview wins), whether it's showing dark, and that palette. */
export function useActiveTheme(): { theme: ThemeDef; dark: boolean; palette: Palette } {
  const appearance = useAppearance()
  const themes = useApp((s) => s.themes)
  const preview = useApp((s) => s.previewTheme)
  const systemDark = useSystemDark()
  const theme = preview ?? themes.find((t) => t.id === appearance?.themeId) ?? BUILTIN_THEMES[0]
  const dark = usesDark(theme, appearance?.mode ?? 'system', systemDark)
  return { theme, dark, palette: dark ? theme.dark : theme.light }
}

/** Apply the saved (or previewed) theme to this window, following system light/dark changes. */
export function useTheme(): void {
  const appearance = useAppearance()
  const { theme, dark } = useActiveTheme()

  useEffect(() => {
    if (!appearance) return
    const background = applyTheme(theme, appearance)
    // A single-palette theme sets the native side too (menus, scrollbars, form controls).
    void api.app.setNativeTheme(theme.only ?? appearance.mode, background)
  }, [appearance, theme, dark])
}
