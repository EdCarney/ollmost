import { useState } from 'react'
import { displayAddress, isOllamaCloudUrl, probeContextNote, probeSummary, suggestEndpointName } from '@shared/endpoints'
import type { Endpoint, EndpointProbe } from '@shared/types'
import { Button, Field, Modal, TextField } from '@/components/ui'
import { api } from '@/lib/api'
import { selectEndpoints, useApp } from '@/stores/app'

const PRESETS = [
  { label: 'Ollama', port: 11434 },
  { label: 'LM Studio', port: 1234 },
  { label: 'llama.cpp', port: 8080 },
  { label: 'vLLM', port: 8000 }
] as const

// Electron prefixes errors thrown in ipcMain handlers; the dialog shows only the message.
const messageOf = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Add an endpoint: an address (and a key, if the server wants one) is checked first; then it's named and added. */
export function AddEndpointDialog({
  open,
  onOpenChange,
  onAdded
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (endpoint: Endpoint) => void | Promise<void>
}) {
  const endpoints = useApp(selectEndpoints)
  const [address, setAddress] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [found, setFound] = useState<EndpointProbe | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (next: boolean) => {
    if (!next) {
      setAddress('')
      setApiKey('')
      setFound(null)
      setName('')
      setError(null)
    }
    onOpenChange(next)
  }

  const check = async () => {
    setBusy(true)
    setError(null)
    try {
      const probe = await api.endpoints.probe({ baseUrl: address, apiKey: apiKey.trim() || undefined })
      setFound(probe)
      setName(
        suggestEndpointName(
          probe,
          endpoints.map((e) => e.name)
        )
      )
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    if (!found) return
    setBusy(true)
    setError(null)
    try {
      const endpoint = await api.endpoints.add({
        name: name.trim(),
        baseUrl: found.baseUrl,
        kind: found.kind,
        flavor: found.flavor,
        apiKey: apiKey.trim() || undefined
      })
      close(false)
      await onAdded(endpoint)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Add an endpoint"
      description={found ? undefined : 'Ollama, LM Studio, llama.cpp or vLLM, on this Mac or another machine.'}
      footer={
        found ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setFound(null)
                setError(null)
              }}
            >
              Back
            </Button>
            <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={() => void add()}>
              Add
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!address.trim()} loading={busy} onClick={() => void check()}>
              Check
            </Button>
          </>
        )
      }
    >
      {found ? (
        <div className="space-y-4">
          <div className="rounded-ollmost border border-line bg-canvas p-3 text-sm">
            <div className="font-medium text-success">{probeSummary(found)}</div>
            <div className="mt-0.5 text-muted">at {displayAddress(found.baseUrl)}</div>
            <div className="mt-0.5 text-muted">{probeContextNote(found)}</div>
          </div>
          {/* addEndpoint never keeps an endpoint key for ollama.com: it takes the account key instead. */}
          {isOllamaCloudUrl(found.baseUrl) && apiKey.trim() && (
            <p className="text-sm text-muted">
              ollama.com takes your ollama.com account key, so the key typed here isn't kept. Set it in “ollama.com account”.
            </p>
          )}
          <Field label="Name">
            <TextField
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && void add()}
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.port}
                type="button"
                onClick={() => setAddress(`http://localhost:${p.port}`)}
                className="rounded-full bg-hover px-2.5 py-0.5 text-xs text-muted hover:text-fg"
              >
                {p.label} :{p.port}
              </button>
            ))}
          </div>
          <Field label="Address">
            <TextField
              autoFocus
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && address.trim() && void check()}
              placeholder="http://localhost:11434"
            />
          </Field>
          <Field label="API key" hint="Only if the server asks for one. It's stored encrypted and only ever sent to this server.">
            <TextField type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  )
}
