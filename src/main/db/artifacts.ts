import type { Artifact, ArtifactSummary, ArtifactType, ArtifactVersion } from '@shared/types'
import { now, uid } from '../util'
import { all, get, run } from './index'

interface ArtifactRow {
  id: string
  conversation_id: string
  identifier: string
  type: string
  title: string
  language: string | null
  created_at: number
  updated_at: number
}

interface VersionRow {
  id: string
  artifact_id: string
  message_id: string | null
  version: number
  content: string
  created_at: number
}

const toVersion = (r: VersionRow): ArtifactVersion => ({
  id: r.id,
  artifactId: r.artifact_id,
  messageId: r.message_id,
  version: r.version,
  content: r.content,
  createdAt: r.created_at
})

function toArtifact(r: ArtifactRow, versions: ArtifactVersion[]): Artifact {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    identifier: r.identifier,
    type: r.type as ArtifactType,
    title: r.title,
    language: r.language,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    versions
  }
}

export function listArtifacts(conversationId: string): Artifact[] {
  const rows = all<ArtifactRow>('SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_at', conversationId)
  const versions = all<VersionRow>(
    `SELECT v.* FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
     WHERE a.conversation_id = ? ORDER BY v.version`,
    conversationId
  )
  return rows.map((r) => toArtifact(r, versions.filter((v) => v.artifact_id === r.id).map(toVersion)))
}

export function getArtifact(id: string): Artifact | null {
  const row = get<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', id)
  if (!row) return null
  const versions = all<VersionRow>('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version', id)
  return toArtifact(row, versions.map(toVersion))
}

/** Add a version to the artifact with this identifier, creating the artifact if needed. */
export function addArtifactVersion(input: {
  conversationId: string
  messageId: string | null
  identifier: string
  type: ArtifactType
  title: string
  language: string | null
  content: string
}): string {
  const t = now()
  let row = get<ArtifactRow>('SELECT * FROM artifacts WHERE conversation_id = ? AND identifier = ?', input.conversationId, input.identifier)
  if (!row) {
    const id = uid()
    run(
      `INSERT INTO artifacts (id, conversation_id, identifier, type, title, language, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.conversationId,
      input.identifier,
      input.type,
      input.title,
      input.language,
      t,
      t
    )
    row = get<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', id)!
  } else {
    run(
      'UPDATE artifacts SET type = ?, title = ?, language = ?, updated_at = ? WHERE id = ?',
      input.type,
      input.title,
      input.language,
      t,
      row.id
    )
  }
  const next = (get<{ v: number | null }>('SELECT MAX(version) AS v FROM artifact_versions WHERE artifact_id = ?', row.id)?.v ?? 0) + 1
  run(
    `INSERT INTO artifact_versions (id, artifact_id, message_id, version, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    uid(),
    row.id,
    input.messageId,
    next,
    input.content,
    t
  )
  return row.id
}

/** After messages are deleted (retry/edit), drop artifacts whose every version went with them. */
export function pruneEmptyArtifacts(conversationId: string): void {
  run(
    `DELETE FROM artifacts WHERE conversation_id = ?
     AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.artifact_id = artifacts.id)`,
    conversationId
  )
}

/** The latest artifacts, from every chat or only a project's. */
export function listAllArtifacts(projectId?: string): ArtifactSummary[] {
  return all<ArtifactRow & { conversation_title: string; project_id: string | null; version_count: number }>(
    `SELECT a.*, c.title AS conversation_title, c.project_id,
       (SELECT COUNT(*) FROM artifact_versions v WHERE v.artifact_id = a.id) AS version_count
     FROM artifacts a JOIN conversations c ON c.id = a.conversation_id
     ${projectId ? 'WHERE c.project_id = ?' : ''}
     ORDER BY a.updated_at DESC LIMIT 500`,
    ...(projectId ? [projectId] : [])
  ).map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    conversationTitle: r.conversation_title,
    projectId: r.project_id,
    identifier: r.identifier,
    type: r.type as ArtifactType,
    title: r.title,
    language: r.language,
    versionCount: r.version_count,
    updatedAt: r.updated_at
  }))
}
