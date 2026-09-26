// What "Allow for this chat" (and a denial) covers, stored on the chat as a key. Kept apart from tool names on
// purpose: an MCP tool's offered name depends on the order its server lists its tools, and a web_fetch answer
// should cover one site, not the whole web.

/** One tool of one MCP server, by the server's fixed id and the tool's own name. */
export const mcpAllowKey = (serverId: string, tool: string): string => `mcp:${serverId}/${tool}`

/** web_fetch on one host. */
export const webFetchAllowKey = (host: string): string => `web_fetch@${host}`

export interface AllowKeyParts {
  /** The tool's own name. */
  tool: string
  /** The MCP server the tool belongs to, by id. */
  serverId?: string
  /** The site a web_fetch answer covers. */
  host?: string
}

/** What a key covers, to show it. Anything else is a plain tool name. */
export function describeAllowKey(key: string): AllowKeyParts {
  const mcp = /^mcp:([^/]+)\/(.+)$/.exec(key)
  if (mcp) return { serverId: mcp[1], tool: mcp[2] }
  const web = /^web_fetch@(.+)$/.exec(key)
  if (web) return { tool: 'web_fetch', host: web[1] }
  // A code session's answers cover its commands, or all its file edits, whichever tool made them.
  if (key === 'code:commands') return { tool: 'run_command' }
  if (key === 'code:edits') return { tool: 'edit_file, write_file' }
  return { tool: key }
}

/** Whether a key belongs to an MCP server. */
export const isServerAllowKey = (key: string, serverId: string): boolean => key.startsWith(`mcp:${serverId}/`)
