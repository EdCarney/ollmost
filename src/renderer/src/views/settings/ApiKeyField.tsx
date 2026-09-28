import { useState } from 'react'
import { Button, Field, TextField } from '@/components/ui'
import { api } from '@/lib/api'
import { reportError, useApp } from '@/stores/app'
import { useUsage } from '@/stores/usage'

export function ApiKeyField({ hasKey, onSaved }: { hasKey: boolean; onSaved?: () => void }) {
  const [apiKey, setApiKey] = useState('')
  const refresh = async () => {
    await useApp.getState().loadSettings()
    await useUsage.getState().load(true)
    onSaved?.()
  }
  return (
    <Field
      label="ollama.com API key"
      hint={
        hasKey ? (
          'A key is saved, encrypted with your macOS keychain.'
        ) : (
          <>
            Create one at{' '}
            <button className="text-accent hover:underline" onClick={() => api.app.openExternal('https://ollama.com/settings/keys')}>
              ollama.com/settings/keys
            </button>
            . It's stored encrypted and only ever sent to ollama.com.
          </>
        )
      }
    >
      <div className="flex gap-2">
        <TextField
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? '••••••••••••' : 'Paste your API key'}
        />
        <Button
          disabled={!apiKey.trim()}
          onClick={async () => {
            try {
              await api.settings.setApiKey(apiKey.trim())
              setApiKey('')
              await refresh()
            } catch (err) {
              reportError(err)
            }
          }}
        >
          Save
        </Button>
        {hasKey && (
          <Button
            variant="ghost"
            onClick={async () => {
              await api.settings.setApiKey(null)
              await refresh()
            }}
          >
            Remove
          </Button>
        )}
      </div>
    </Field>
  )
}
