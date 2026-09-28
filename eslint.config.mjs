import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // The model-endpoints capture spike's script is kept exactly as the plan wrote it; nothing in that folder ships.
  { ignores: ['out/', 'dist/', 'e2e/shots/', 'docs/superpowers/plans/2026-09-27-model-endpoints-capture/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // A leading underscore marks a value that's deliberately unused (`_event`, a destructured-away field).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  },
  // Main process, preload, tests and scripts run in Node; the renderer runs in the browser. The e2e script is
  // both: Playwright code in Node, plus callbacks passed to evaluate() that run in the app's page.
  { files: ['src/main/**', 'src/preload/**', 'tests/**', 'scripts/**', '*.{ts,mjs}'], languageOptions: { globals: globals.node } },
  { files: ['e2e/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['src/renderer/**'], languageOptions: { globals: globals.browser } },
  // The classic hook rules only. The plugin's recommended preset also has React Compiler diagnostics
  // (set-state-in-effect, refs, purity…), which flag ordinary patterns here; Ollmost doesn't use the compiler.
  {
    files: ['src/renderer/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' }
  }
)
