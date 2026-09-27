import { normalizeFolder } from '@shared/fileTree'
import type { Project, ProjectFile } from '@shared/types'
import { fromStored, toStored } from '../paths'
import { now, uid } from '../util'
import { all, get, run, transaction } from './index'

interface ProjectRow {
  id: string
  name: string
  description: string
  instructions: string
  pinned: number
  created_at: number
  updated_at: number
  conversation_count?: number
}

interface ProjectFileRow {
  id: string
  project_id: string
  name: string
  mime: string
  size: number
  path: string
  text: string | null
  token_est: number
  folder: string
  created_at: number
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  pinned: !!r.pinned,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  conversationCount: r.conversation_count
})

const toFile = (r: ProjectFileRow): ProjectFile => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  mime: r.mime,
  size: r.size,
  tokenEstimate: r.token_est,
  createdAt: r.created_at,
  folder: r.folder
})

export function listProjects(): Project[] {
  return all<ProjectRow>(
    `SELECT p.*, (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS conversation_count
     FROM projects p ORDER BY p.updated_at DESC`
  ).map(toProject)
}

export function getProject(id: string): Project | null {
  const row = get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
  return row ? toProject(row) : null
}

export function createProject(input: { name: string; description?: string }): Project {
  const id = uid()
  const t = now()
  run(
    'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id,
    input.name.trim() || 'Untitled project',
    input.description?.trim() ?? '',
    t,
    t
  )
  return getProject(id)!
}

export function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'pinned'>>): Project {
  const p = getProject(id)
  if (!p) throw new Error('Project not found')
  run(
    'UPDATE projects SET name = ?, description = ?, instructions = ?, pinned = ?, updated_at = ? WHERE id = ?',
    patch.name ?? p.name,
    patch.description ?? p.description,
    patch.instructions ?? p.instructions,
    (patch.pinned ?? p.pinned) ? 1 : 0,
    // Pinning shouldn't reorder "recently updated".
    patch.pinned !== undefined && Object.keys(patch).length === 1 ? p.updatedAt : now(),
    id
  )
  return getProject(id)!
}

export function touchProject(id: string): void {
  run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), id)
}

export function deleteProject(id: string): string[] {
  const paths = all<{ path: string }>(
    `SELECT path FROM project_files WHERE project_id = ?
     UNION ALL
     SELECT a.path FROM attachments a JOIN messages m ON m.id = a.message_id
       JOIN conversations c ON c.id = m.conversation_id WHERE c.project_id = ?`,
    id,
    id
  ).map((r) => fromStored(r.path))
  transaction(() => {
    run(`DELETE FROM search_index WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)`, id)
    run('DELETE FROM projects WHERE id = ?', id)
  })
  return paths
}

export function listProjectFiles(projectId: string): ProjectFile[] {
  return all<ProjectFileRow>('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at', projectId).map(toFile)
}

/** Whether a project has any knowledge files. */
export function hasProjectFiles(projectId: string): boolean {
  return !!get<{ one: number }>('SELECT 1 AS one FROM project_files WHERE project_id = ? LIMIT 1', projectId)
}

/** Files with their extracted text, for prompt assembly. */
export function projectKnowledge(projectId: string): Array<{ name: string; text: string }> {
  return all<{ name: string; folder: string; text: string | null }>(
    'SELECT name, folder, text FROM project_files WHERE project_id = ? ORDER BY created_at',
    projectId
  ).map((r) => ({ name: r.folder ? `${r.folder}/${r.name}` : r.name, text: r.text ?? '' }))
}

export function insertProjectFile(f: Omit<ProjectFileRow, 'created_at'>): ProjectFile {
  run(
    `INSERT INTO project_files (id, project_id, name, mime, size, path, text, token_est, folder, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.id,
    f.project_id,
    f.name,
    f.mime,
    f.size,
    toStored(f.path),
    f.text,
    f.token_est,
    normalizeFolder(f.folder),
    now()
  )
  touchProject(f.project_id)
  return toFile(get<ProjectFileRow>('SELECT * FROM project_files WHERE id = ?', f.id)!)
}

/** Move a file to another folder ('' for the root): folders are prefixes, so this is all a move is. */
export function moveProjectFile(id: string, folder: string): ProjectFile {
  run('UPDATE project_files SET folder = ? WHERE id = ?', normalizeFolder(folder), id)
  const row = get<ProjectFileRow>('SELECT * FROM project_files WHERE id = ?', id)
  if (!row) throw new Error('File not found')
  touchProject(row.project_id)
  return toFile(row)
}

/** Where a project file is kept on disk and what it's called, or null when there's no such file. */
export function projectFileOnDisk(id: string): { path: string; name: string } | null {
  const row = get<{ path: string; name: string }>('SELECT path, name FROM project_files WHERE id = ?', id)
  return row ? { path: fromStored(row.path), name: row.name } : null
}

export function deleteProjectFile(id: string): string | null {
  const row = get<{ path: string }>('SELECT path FROM project_files WHERE id = ?', id)
  run('DELETE FROM project_files WHERE id = ?', id)
  return row ? fromStored(row.path) : null
}
