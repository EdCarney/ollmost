// A project's files as a tree: folders are the files' `folder` paths (prefixes, never stored on their own), so the
// tree is built from the list each time, plus any empty folders the viewer has made and not yet filled.

export interface TreeFile {
  id: string
  name: string
  folder: string
}

export type TreeNode<F extends TreeFile = TreeFile> =
  { kind: 'folder'; name: string; path: string; children: TreeNode<F>[] } | { kind: 'file'; name: string; file: F }

/** A folder path as stored: segments joined by '/', no empty, '.' or '..' segments, '' for the root. */
export function normalizeFolder(folder: string): string {
  return folder
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** The tree for `files`, folders first at every level, each level sorted by name; `extraFolders` appear even when empty. */
export function buildTree<F extends TreeFile>(files: F[], extraFolders: string[] = []): TreeNode<F>[] {
  const root: TreeNode<F>[] = []
  const folderAt = (path: string): TreeNode<F>[] => {
    let level = root
    let sofar = ''
    for (const seg of normalizeFolder(path).split('/').filter(Boolean)) {
      sofar = sofar ? `${sofar}/${seg}` : seg
      let node = level.find((n): n is Extract<TreeNode<F>, { kind: 'folder' }> => n.kind === 'folder' && n.name === seg)
      if (!node) {
        node = { kind: 'folder', name: seg, path: sofar, children: [] }
        level.push(node)
      }
      level = node.children
    }
    return level
  }
  for (const folder of extraFolders) folderAt(folder)
  for (const file of files) folderAt(file.folder).push({ kind: 'file', name: file.name, file })
  const sort = (nodes: TreeNode<F>[]): TreeNode<F>[] => {
    nodes.sort((a, b) => (a.kind === b.kind ? byName(a.name, b.name) : a.kind === 'folder' ? -1 : 1))
    for (const n of nodes) if (n.kind === 'folder') sort(n.children)
    return nodes
  }
  return sort(root)
}
