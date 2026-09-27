// Each entry runs once, in order, tracked by PRAGMA user_version. Never edit a shipped entry — append.
export const MIGRATIONS: string[] = [
  /* sql */ `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    text TEXT,
    token_est INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    model TEXT,
    think TEXT,
    skills TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX conversations_updated ON conversations(updated_at DESC);
  CREATE INDEX conversations_project ON conversations(project_id, updated_at DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    thinking TEXT,
    model TEXT,
    tool_events TEXT NOT NULL DEFAULT '[]',
    stats TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, created_at);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    text TEXT,
    token_est INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_message ON attachments(message_id);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    identifier TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    language TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (conversation_id, identifier)
  );

  CREATE TABLE artifact_versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX artifact_versions_artifact ON artifact_versions(artifact_id, version);

  CREATE TABLE model_profiles (
    model TEXT PRIMARY KEY,
    info TEXT,
    fetched_at INTEGER,
    overrides TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE themes (
    id TEXT PRIMARY KEY,
    def TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- One row per message (message_id set) plus one per conversation title (message_id NULL).
  CREATE VIRTUAL TABLE search_index USING fts5(
    conversation_id UNINDEXED,
    message_id UNINDEXED,
    body,
    tokenize = 'porter unicode61'
  );
  `,
  /* sql */ `
  -- Skills the model loaded itself (via load_skill), kept apart from ones the user picked.
  ALTER TABLE conversations ADD COLUMN auto_skills TEXT NOT NULL DEFAULT '[]';
  `,
  /* sql */ `
  -- One row per billed request (chat rounds, titles). Kept when messages or chats are deleted,
  -- because the tokens were still spent.
  CREATE TABLE usage_events (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    message_id TEXT,
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    estimated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX usage_events_conversation ON usage_events(conversation_id, created_at);
  CREATE INDEX usage_events_created ON usage_events(created_at);
  `,
  /* sql */ `
  -- Recorded requests for the debugger. Deleting a chat deletes its traces; only the newest 500 are kept.
  CREATE TABLE traces (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT,
    kind TEXT NOT NULL,
    model TEXT,
    round INTEGER,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cost_usd REAL,
    summary TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL
  );
  CREATE INDEX traces_conversation ON traces(conversation_id, started_at);
  CREATE INDEX traces_started ON traces(started_at);
  `,
  /* sql */ `
  -- Instructions for one chat (a system prompt or persona), on top of preferences and project instructions.
  ALTER TABLE conversations ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
  `,
  /* sql */ `
  -- Tools the user allowed to run without asking in this chat ("Allow for this chat").
  ALTER TABLE conversations ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]';
  `,
  /* sql */ `
  -- Tool sources switched on for a chat (MCP servers as "mcp:<id>").
  ALTER TABLE conversations ADD COLUMN tool_sources TEXT NOT NULL DEFAULT '[]';
  `,
  /* sql */ `
  -- "Allow for this chat" answers were stored by offered tool name; they're now keyed by server and tool (or site),
  -- so the old ones can't be read reliably. Clearing them means each tool asks once more.
  UPDATE conversations SET allowed_tools = '[]';
  `,
  /* sql */ `
  -- File paths relative to the data folder (files/<name>), so the folder can move (#60). Every stored file is in
  -- files/; replace(path, rtrim(path, replace(path, '/', '')), '') is SQLite's way to take a path's last part.
  UPDATE attachments SET path = 'files/' || replace(path, rtrim(path, replace(path, '/', '')), '') WHERE path LIKE '/%';
  UPDATE project_files SET path = 'files/' || replace(path, rtrim(path, replace(path, '/', '')), '') WHERE path LIKE '/%';
  `,
  /* sql */ `
  -- The debugger's recorded endpoints for built-in tools, under the app's new URL scheme (#60).
  UPDATE traces SET data = replace(data, '"endpoint":"kiln://', '"endpoint":"ollmost://') WHERE data LIKE '%"endpoint":"kiln://%';
  `,
  /* sql */ `
  -- Code sessions: agentic work in a folder of the user's, which Ollmost never owns (#78). \`root\` is that folder's
  -- real path; null for a chat.
  ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat';
  ALTER TABLE conversations ADD COLUMN root TEXT;
  CREATE INDEX conversations_mode ON conversations(mode, updated_at DESC);
  `,
  /* sql */ `
  -- A code session's network preset (CodeNetwork in src/shared/types.ts): what its commands may reach.
  ALTER TABLE conversations ADD COLUMN network TEXT NOT NULL DEFAULT 'none';
  `,
  /* sql */ `
  -- A reply's thinking, one segment per round with where the round began (ThinkingSegment[] as JSON), so it can be
  -- shown where it happened (#109). \`thinking\` keeps the joined text; null here means a reply from before.
  ALTER TABLE messages ADD COLUMN thinking_segments TEXT;
  `
]
