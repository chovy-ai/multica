-- Local conversation store, schema version 1.
-- Relationships are validated by the store in transactions; there are no
-- foreign keys or cascades.

CREATE TABLE store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE scope (
    id INTEGER PRIMARY KEY,
    api_origin TEXT NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    scope_seq INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX scope_identity ON scope (api_origin, user_id, workspace_id);

CREATE TABLE conversation (
    id TEXT PRIMARY KEY,
    scope_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_session_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    title_mode TEXT NOT NULL DEFAULT 'auto',
    cwd TEXT NOT NULL DEFAULT '',
    model TEXT,
    reasoning_effort TEXT,
    permission_mode TEXT NOT NULL DEFAULT 'default',
    project_id TEXT,
    side_source_id TEXT NOT NULL DEFAULT '',
    forked_from_id TEXT NOT NULL DEFAULT '',
    forked_from_turn_id TEXT NOT NULL DEFAULT '',
    imported_from_session_id TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    last_seq INTEGER NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    summary_seq INTEGER NOT NULL DEFAULT 0,
    last_message_preview TEXT NOT NULL DEFAULT '',
    pending_interactions INTEGER NOT NULL DEFAULT 0,
    queue_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX conversation_list ON conversation (scope_id, archived, pinned, updated_at);
CREATE INDEX conversation_summary ON conversation (scope_id, summary_seq);

CREATE TABLE turn (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    provider_turn_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    error_kind TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    reconciled INTEGER NOT NULL DEFAULT 0,
    last_turn_seq INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE UNIQUE INDEX turn_order ON turn (conversation_id, turn_index);

CREATE TABLE message (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    attachment_ids TEXT NOT NULL DEFAULT '[]',
    steered INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX message_turn ON message (conversation_id, turn_id);

CREATE TABLE event (
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    turn_id TEXT,
    turn_seq INTEGER,
    item_id TEXT,
    type TEXT NOT NULL,
    final INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, seq)
);
CREATE INDEX event_final ON event (conversation_id, turn_id, seq) WHERE final = 1;
CREATE INDEX event_item ON event (conversation_id, item_id, seq) WHERE item_id IS NOT NULL;

CREATE TABLE interaction_request (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider_request_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    answer TEXT,
    answered_by_connection TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
CREATE INDEX interaction_request_status ON interaction_request (conversation_id, status);

CREATE TABLE prompt_queue (
    conversation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE prompt_queue_item (
    conversation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    item TEXT NOT NULL,
    PRIMARY KEY (conversation_id, request_id)
);
CREATE INDEX prompt_queue_order ON prompt_queue_item (conversation_id, position);

CREATE TABLE attachment (
    id TEXT PRIMARY KEY,
    scope_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    file_name TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX attachment_conversation ON attachment (conversation_id);

CREATE TABLE folder_project (
    id TEXT PRIMARY KEY,
    scope_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX folder_project_scope ON folder_project (scope_id);

CREATE TABLE preview_root (
    scope_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, path)
);

CREATE TABLE command_receipt (
    scope_id INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result TEXT NOT NULL,
    uncertain INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, request_id)
);
