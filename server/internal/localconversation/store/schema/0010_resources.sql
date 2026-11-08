CREATE TABLE conversation_resource_state (
    conversation_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    coverage TEXT NOT NULL,
    reason TEXT NOT NULL,
    recorded_from TEXT NOT NULL
);

CREATE TABLE conversation_file_change (
    conversation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    path TEXT NOT NULL,
    metadata TEXT NOT NULL,
    baseline TEXT NOT NULL,
    latest TEXT NOT NULL,
    patch TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, id)
);

CREATE TABLE conversation_file_operation (
    conversation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    PRIMARY KEY (conversation_id, operation_id)
);

CREATE VIEW conversation_resource_entry AS
SELECT f.conversation_id, 'f:' || f.id AS cursor_id, 'change' AS entry_type, f.metadata FROM conversation_file_change f
 UNION ALL
 SELECT a.conversation_id, 'a:' || a.id AS cursor_id, 'attachment' AS entry_type,
 json_object('id', a.id, 'name', a.file_name, 'media_type', a.media_type, 'size', a.size,
 'source', CASE WHEN EXISTS (SELECT 1 FROM message m, json_each(m.attachment_ids) j WHERE m.conversation_id = a.conversation_id AND m.role = 'user' AND j.value = a.id) THEN 'input' ELSE 'output' END) AS metadata
 FROM attachment a WHERE (
 EXISTS (SELECT 1 FROM message m, json_each(m.attachment_ids) j WHERE m.conversation_id = a.conversation_id AND j.value = a.id)
 OR EXISTS (SELECT 1 FROM event e WHERE e.conversation_id = a.conversation_id AND json_extract(e.payload, '$.attachment_id') = a.id));
