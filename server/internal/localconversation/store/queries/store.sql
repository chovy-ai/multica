-- name: GetMeta :one
SELECT value FROM store_meta WHERE key = ?;

-- name: PutMeta :exec
INSERT INTO store_meta (key, value) VALUES (?, ?)
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

-- name: GetScopeID :one
SELECT id FROM scope WHERE api_origin = ? AND user_id = ? AND workspace_id = ?;

-- name: InsertScope :one
INSERT INTO scope (api_origin, user_id, workspace_id) VALUES (?, ?, ?) RETURNING id;

-- name: BumpScopeSeq :one
UPDATE scope SET scope_seq = scope_seq + 1 WHERE id = ? RETURNING scope_seq;

-- name: GetScopeSeq :one
SELECT scope_seq FROM scope WHERE id = ?;

-- name: InsertConversation :exec
INSERT INTO conversation (
    id, scope_id, provider, provider_session_id, title, title_mode, cwd, model,
    reasoning_effort, permission_mode, project_id, side_source_id, forked_from_id,
    forked_from_turn_id, imported_from_session_id, summary_seq, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetConversation :one
SELECT * FROM conversation WHERE id = ?;

-- name: AdvanceConversationSeq :exec
UPDATE conversation SET last_seq = ? WHERE id = ?;

-- name: UpdateConversationSummary :exec
UPDATE conversation SET
    status = ?,
    title = ?,
    last_message_preview = ?,
    pending_interactions = ?,
    queue_count = ?,
    summary_seq = ?,
    updated_at = ?
WHERE id = ?;

-- name: SetProviderSessionID :exec
UPDATE conversation SET provider_session_id = ? WHERE id = ?;

-- name: SetConversationTurnCount :exec
UPDATE conversation SET turn_count = ? WHERE id = ?;

-- name: ListSummariesAfter :many
SELECT * FROM conversation
WHERE scope_id = sqlc.arg(scope_id) AND summary_seq > sqlc.arg(after_scope_seq)
ORDER BY summary_seq
LIMIT sqlc.arg(row_limit);

-- name: InsertTurn :exec
INSERT INTO turn (id, conversation_id, turn_index, request_id, status, started_at)
VALUES (?, ?, ?, ?, ?, ?);

-- name: GetTurn :one
SELECT * FROM turn WHERE id = ?;

-- name: AdvanceTurnSeq :exec
UPDATE turn SET last_turn_seq = ? WHERE id = ?;

-- name: CompleteTurn :exec
UPDATE turn SET status = ?, error_kind = ?, error = ?, completed_at = ? WHERE id = ?;

-- name: SetProviderTurnID :exec
UPDATE turn SET provider_turn_id = ? WHERE id = ?;

-- name: ListRecentTurns :many
SELECT * FROM turn
WHERE conversation_id = sqlc.arg(conversation_id)
ORDER BY turn_index DESC
LIMIT sqlc.arg(row_limit);

-- name: ListTurnsBefore :many
SELECT * FROM turn
WHERE conversation_id = sqlc.arg(conversation_id) AND turn_index < sqlc.arg(before_index)
ORDER BY turn_index DESC
LIMIT sqlc.arg(row_limit);

-- name: ListRunningTurns :many
SELECT * FROM turn WHERE status = 'running' ORDER BY conversation_id, turn_index;

-- name: InsertMessage :exec
INSERT INTO message (id, conversation_id, turn_id, role, content, attachment_ids, steered, failed, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListTurnMessages :many
SELECT * FROM message
WHERE conversation_id = ? AND turn_id = ?
ORDER BY created_at, id;

-- name: InsertEvent :exec
INSERT INTO event (conversation_id, seq, turn_id, turn_seq, item_id, type, final, payload, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListEventsAfter :many
SELECT * FROM event
WHERE conversation_id = sqlc.arg(conversation_id)
  AND seq > sqlc.arg(after_seq)
  AND seq <= sqlc.arg(through_seq)
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- name: ListTurnEvents :many
SELECT * FROM event
WHERE conversation_id = ? AND turn_id = ?
ORDER BY seq;

-- name: ListTurnFinalEvents :many
SELECT * FROM event
WHERE conversation_id = ? AND turn_id = ? AND final = 1
ORDER BY seq;

-- name: ListItemEvents :many
SELECT * FROM event
WHERE conversation_id = ? AND item_id = ?
ORDER BY seq;

-- name: ListPendingInteractions :many
SELECT * FROM interaction_request
WHERE conversation_id = ? AND status = 'pending'
ORDER BY created_at, id;

-- name: InsertAttachment :exec
INSERT INTO attachment (id, scope_id, conversation_id, path, size, media_type, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: GetAttachment :one
SELECT * FROM attachment WHERE id = ?;

-- name: CountAttachmentsAtPath :one
SELECT COUNT(*) FROM attachment WHERE path = ?;

-- name: InsertCommandReceipt :exec
INSERT INTO command_receipt (scope_id, request_id, fingerprint, result, uncertain, created_at)
VALUES (?, ?, ?, ?, ?, ?);

-- name: GetCommandReceipt :one
SELECT * FROM command_receipt WHERE scope_id = ? AND request_id = ?;

-- name: MarkCommandUncertain :exec
UPDATE command_receipt SET uncertain = 1 WHERE scope_id = ? AND request_id = ?;
