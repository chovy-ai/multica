package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
	"github.com/multica-ai/multica/server/pkg/codexappserver"
)

var (
	// ErrImportRunning rejects a second import in a workspace.
	ErrImportRunning = errors.New("local conversation: a conversation import is already running in this workspace")
	nativeID         = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
)

const (
	importPage     = 50
	maxImportBatch = 100
)

// ImportCandidate is a native session that can be imported.
type ImportCandidate struct {
	ID         string `json:"id"`
	Provider   string `json:"provider"`
	Title      string `json:"title"`
	Cwd        string `json:"cwd"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
	ImportedID string `json:"imported_id,omitempty"`
}

// ImportPage is one page of native sessions.
type ImportPage struct {
	Sessions   []ImportCandidate `json:"sessions"`
	NextCursor *string           `json:"next_cursor"`
}

// ImportOutcome is one source session's result.
type ImportOutcome struct {
	SourceID       string `json:"source_id"`
	ConversationID string `json:"conversation_id,omitempty"`
	Error          string `json:"error,omitempty"`
}

// ImportResult reports a batch import.
type ImportResult struct {
	Imported []ImportOutcome `json:"imported"`
	Skipped  []ImportOutcome `json:"skipped"`
	Failed   []ImportOutcome `json:"failed"`
}

// nativeTurn is one turn of a native history.
type nativeTurn struct {
	status    string
	startedAt time.Time
	user      string
	items     []map[string]any
	replies   []string
}

type nativeSession struct {
	ImportCandidate
	turns []nativeTurn
}

type imports struct {
	mu   sync.Mutex
	busy map[int64]context.CancelFunc
}

// historyReader lists, reads and forks one provider's native sessions
// without starting a model turn.
type historyReader interface {
	list(ctx context.Context, cursor string) (ImportPage, error)
	read(ctx context.Context, id string) (nativeSession, error)
	fork(ctx context.Context, id, title string) (string, error)
	close()
}

func (s *Service) openHistory(ctx context.Context, provider string) (historyReader, error) {
	home, _ := os.UserHomeDir()
	stub := sqlitedb.Conversation{Provider: provider, Cwd: home}
	switch {
	case provider == "claude" && s.opts.Claude != nil:
		_, start, err := s.opts.Claude(ctx, stub)
		if err != nil {
			return nil, err
		}
		adapter, err := start(ctx, func(claude.Output) {})
		if err != nil {
			return nil, err
		}
		return &claudeHistory{adapter: adapter}, nil
	case provider == "codex" && s.opts.Codex != nil:
		_, start, err := s.opts.Codex(ctx, stub)
		if err != nil {
			return nil, err
		}
		server, err := start(ctx, func(codexappserver.Frame) {}, nil)
		if err != nil {
			return nil, err
		}
		return &codexHistory{server: server}, nil
	}
	return nil, fmt.Errorf("%w: %s", ErrUnsupportedProvider, provider)
}

// ImportList lists a provider's native sessions, marking those already
// imported into the scope.
func (s *Service) ImportList(ctx context.Context, scopeID int64, provider, cursor string) (ImportPage, error) {
	h, err := s.openHistory(ctx, provider)
	if err != nil {
		return ImportPage{}, err
	}
	defer h.close()
	page, err := h.list(ctx, cursor)
	if err != nil {
		return page, err
	}
	for i, c := range page.Sessions {
		if conv, err := s.store.ImportedConversation(ctx, scopeID, provider, c.ID); err == nil {
			page.Sessions[i].ImportedID = conv.ID
		}
	}
	if page.Sessions == nil {
		page.Sessions = []ImportCandidate{}
	}
	return page, nil
}

// CancelImport stops the scope's running import.
func (s *Service) CancelImport(scopeID int64) {
	s.imports.mu.Lock()
	cancel := s.imports.busy[scopeID]
	s.imports.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Import copies native sessions into new conversations. Each source is
// forked first, so the import never resumes or edits the user's own
// session; the copy is read from the fork and committed with its whole
// history in one transaction. Already imported sources are skipped.
func (s *Service) Import(ctx context.Context, scopeID int64, provider string, ids []string, projectID *string) (ImportResult, error) {
	if len(ids) == 0 || len(ids) > maxImportBatch {
		return ImportResult{}, fmt.Errorf("%w: select between 1 and %d native sessions", ErrInvalidRequest, maxImportBatch)
	}
	for _, id := range ids {
		if !nativeID.MatchString(id) {
			return ImportResult{}, fmt.Errorf("%w: invalid native session id", ErrInvalidRequest)
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.imports.mu.Lock()
	if s.imports.busy[scopeID] != nil {
		s.imports.mu.Unlock()
		return ImportResult{}, ErrImportRunning
	}
	s.imports.busy[scopeID] = cancel
	s.imports.mu.Unlock()
	defer func() {
		s.imports.mu.Lock()
		delete(s.imports.busy, scopeID)
		s.imports.mu.Unlock()
	}()

	h, err := s.openHistory(ctx, provider)
	if err != nil {
		return ImportResult{}, err
	}
	defer h.close()
	result := ImportResult{Imported: []ImportOutcome{}, Skipped: []ImportOutcome{}, Failed: []ImportOutcome{}}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if conv, err := s.store.ImportedConversation(ctx, scopeID, provider, id); err == nil {
			result.Skipped = append(result.Skipped, ImportOutcome{SourceID: id, ConversationID: conv.ID})
			continue
		}
		convID, err := s.importOne(ctx, scopeID, provider, id, projectID, h)
		if err != nil {
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			result.Failed = append(result.Failed, ImportOutcome{SourceID: id, Error: err.Error()})
			continue
		}
		result.Imported = append(result.Imported, ImportOutcome{SourceID: id, ConversationID: convID})
	}
	return result, nil
}

func (s *Service) importOne(ctx context.Context, scopeID int64, provider, sourceID string, projectID *string, h historyReader) (string, error) {
	source, err := h.read(ctx, sourceID)
	if err != nil {
		return "", err
	}
	if source.ID != sourceID || len(source.turns) == 0 {
		return "", errors.New("Native conversation has no readable messages")
	}
	if info, err := os.Stat(source.Cwd); !filepath.IsAbs(source.Cwd) || err != nil || !info.IsDir() {
		return "", errors.New("The original working directory is unavailable")
	}
	branchID, err := h.fork(ctx, sourceID, source.Title)
	if err != nil {
		return "", err
	}
	if !nativeID.MatchString(branchID) || branchID == sourceID {
		return "", errors.New("The provider did not create an independent history branch")
	}
	// Read the branch, so native activity on the source cannot change the copy.
	branch, err := h.read(ctx, branchID)
	if err != nil || len(branch.turns) == 0 {
		return "", errors.New("Could not read the independent history branch")
	}
	id := newID()
	createdAt, _ := time.Parse(time.RFC3339, source.CreatedAt)
	if createdAt.IsZero() {
		createdAt = s.opts.Now()
	}
	nc := store.NewConversation{
		ID: id, ScopeID: scopeID, Provider: provider, ProviderSessionID: branchID, ImportedFromSessionID: sourceID,
		Title: source.Title, TitleMode: "manual", Cwd: source.Cwd, ProjectID: projectID, CreatedAt: createdAt,
	}
	if _, err := s.store.ImportConversation(ctx, nc, importBatches(id, branch.turns)); err != nil {
		return "", err
	}
	if _, err := s.publishCreated(ctx, id); err != nil {
		return "", err
	}
	return id, nil
}

// importBatches records each native turn as a completed turn: the user
// message, its tool calls and its answers as final items.
func importBatches(conversationID string, turns []nativeTurn) []store.Batch {
	var out []store.Batch
	idle := "idle"
	for i, t := range turns {
		// Zero-padded ids keep messages in order when timestamps tie.
		turnID := fmt.Sprintf("%s~import-%05d", conversationID, i+1)
		at := t.startedAt
		event := func(item, typ string, final bool, payload map[string]any) store.NewEvent {
			data, _ := json.Marshal(payload)
			return store.NewEvent{TurnID: turnID, ItemID: item, Type: typ, Final: final, Payload: data, CreatedAt: at}
		}
		b := store.Batch{StartTurn: &store.NewTurn{ID: turnID, RequestID: turnID, StartedAt: at}}
		if t.user != "" {
			messageID := turnID + "~m000"
			b.Messages = append(b.Messages, store.NewMessage{ID: messageID, TurnID: turnID, Role: "user", Content: t.user, CreatedAt: at})
			b.Events = append(b.Events, event("", "user.message", true, map[string]any{"message_id": messageID, "content": t.user}))
		}
		b.Events = append(b.Events, event("", "turn.started", false, map[string]any{"request_id": turnID}))
		for j, item := range t.items {
			b.Events = append(b.Events, event(fmt.Sprintf("%s~tool-%03d", turnID, j+1), "item.completed", true, item))
		}
		for j, reply := range t.replies {
			itemID := fmt.Sprintf("%s~m%03d", turnID, j+1)
			b.Messages = append(b.Messages, store.NewMessage{ID: itemID, TurnID: turnID, Role: "assistant", Content: reply, CreatedAt: at})
			b.Events = append(b.Events, event(itemID, "item.completed", true, map[string]any{"kind": "assistant_text", "status": "completed", "text": reply}))
		}
		b.Events = append(b.Events, event("", "turn.completed", true, map[string]any{"status": t.status}))
		b.CompleteTurn = &store.TurnCompletion{TurnID: turnID, Status: t.status, CompletedAt: at}
		preview := ""
		if n := len(t.replies); n > 0 {
			preview = truncateRunes(t.replies[n-1], previewRunes)
		}
		b.Summary = &store.SummaryPatch{Status: &idle, LastMessagePreview: &preview, UpdatedAt: at}
		out = append(out, b)
	}
	return out
}

// --- Claude ---

type claudeHistory struct{ adapter ClaudeAdapter }

func (h *claudeHistory) close() { _ = h.adapter.Close(context.Background()) }

func (h *claudeHistory) list(ctx context.Context, cursor string) (ImportPage, error) {
	offset := 0
	if cursor != "" {
		n, err := strconv.Atoi(cursor)
		if err != nil || n < 0 {
			return ImportPage{}, fmt.Errorf("%w: invalid Claude history cursor", ErrInvalidRequest)
		}
		offset = n
	}
	raw, err := h.adapter.Request(ctx, "list_sessions", map[string]any{"limit": importPage, "offset": offset})
	if err != nil {
		return ImportPage{}, err
	}
	var rows []claudeSessionInfo
	if err := json.Unmarshal(raw, &rows); err != nil {
		return ImportPage{}, errors.New("Claude Code returned an invalid history page")
	}
	page := ImportPage{}
	for _, r := range rows {
		if r.Cwd != "" {
			page.Sessions = append(page.Sessions, r.candidate())
		}
	}
	if len(rows) == importPage {
		next := strconv.Itoa(offset + importPage)
		page.NextCursor = &next
	}
	return page, nil
}

type claudeSessionInfo struct {
	SessionID    string `json:"sessionId"`
	Cwd          string `json:"cwd"`
	CustomTitle  string `json:"customTitle"`
	Summary      string `json:"summary"`
	FirstPrompt  string `json:"firstPrompt"`
	CreatedAt    any    `json:"createdAt"`
	LastModified any    `json:"lastModified"`
	FileSize     int64  `json:"fileSize"`
}

func (r claudeSessionInfo) candidate() ImportCandidate {
	title := firstNonEmpty(r.CustomTitle, r.Summary, r.FirstPrompt, "Claude Code")
	updated := isoTime(r.LastModified, "")
	return ImportCandidate{ID: r.SessionID, Provider: "claude", Title: truncateRunes(title, 256), Cwd: r.Cwd, CreatedAt: isoTime(r.CreatedAt, updated), UpdatedAt: updated}
}

func (h *claudeHistory) read(ctx context.Context, id string) (nativeSession, error) {
	raw, err := h.adapter.Request(ctx, "get_session_info", map[string]any{"session_id": id})
	if err != nil {
		return nativeSession{}, err
	}
	var info *claudeSessionInfo
	if json.Unmarshal(raw, &info) != nil || info == nil || info.Cwd == "" {
		return nativeSession{}, errors.New("Claude Code history or its working directory is unavailable")
	}
	if info.FileSize > 64<<20 {
		return nativeSession{}, errors.New("This conversation exceeds the history import size limit")
	}
	info.SessionID = id
	session := nativeSession{ImportCandidate: info.candidate()}
	raw, err = h.adapter.Request(ctx, "get_session_messages", map[string]any{"session_id": id})
	if err != nil {
		return session, err
	}
	var messages []struct {
		Type      string `json:"type"`
		Timestamp any    `json:"timestamp"`
		Message   struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &messages); err != nil {
		return session, errors.New("Claude Code returned invalid history")
	}
	created, _ := time.Parse(time.RFC3339, session.CreatedAt)
	var turn *nativeTurn
	for _, m := range messages {
		text := blockText(m.Message.Content)
		at, _ := time.Parse(time.RFC3339, isoTime(m.Timestamp, session.CreatedAt))
		if at.IsZero() {
			at = created
		}
		if turn == nil || (m.Type == "user" && text != "") {
			session.turns = append(session.turns, nativeTurn{status: "completed", startedAt: at})
			turn = &session.turns[len(session.turns)-1]
		}
		switch {
		case m.Type == "user" && text != "":
			turn.user = text
		case m.Type == "assistant" && text != "":
			turn.replies = append(turn.replies, text)
		}
		var blocks []map[string]any
		_ = json.Unmarshal(m.Message.Content, &blocks)
		for _, b := range blocks {
			if b["type"] == "tool_use" {
				name, _ := b["name"].(string)
				turn.items = append(turn.items, map[string]any{"kind": "tool_call", "status": "completed", "tool": name, "input": b["input"], "output": ""})
			}
		}
	}
	return session, nil
}

func (h *claudeHistory) fork(ctx context.Context, id, title string) (string, error) {
	raw, err := h.adapter.Request(ctx, "fork_session", map[string]any{"session_id": id, "title": title})
	if err != nil {
		return "", err
	}
	var out struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(raw, &out)
	return out.SessionID, nil
}

// --- Codex ---

type codexHistory struct{ server CodexServer }

func (h *codexHistory) close() { h.server.Stop() }

type codexThread struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Preview   string `json:"preview"`
	Cwd       string `json:"cwd"`
	CreatedAt any    `json:"createdAt"`
	UpdatedAt any    `json:"updatedAt"`
	Ephemeral bool   `json:"ephemeral"`
}

func (t codexThread) candidate() (ImportCandidate, error) {
	created := isoUnix(t.CreatedAt)
	if t.ID == "" || t.Cwd == "" || created == "" {
		return ImportCandidate{}, errors.New("Codex returned invalid session metadata")
	}
	updated := isoUnix(t.UpdatedAt)
	if updated == "" {
		updated = created
	}
	return ImportCandidate{ID: t.ID, Provider: "codex", Title: truncateRunes(firstNonEmpty(t.Name, t.Preview, "Codex"), 256), Cwd: t.Cwd, CreatedAt: created, UpdatedAt: updated}, nil
}

// list pages active threads, then archived ones; the cursor encodes which.
func (h *codexHistory) list(ctx context.Context, cursor string) (ImportPage, error) {
	type state struct {
		Archived bool    `json:"archived"`
		Cursor   *string `json:"cursor"`
	}
	var st state
	if cursor != "" {
		data, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(data, &st) != nil {
			return ImportPage{}, fmt.Errorf("%w: invalid Codex history cursor", ErrInvalidRequest)
		}
	}
	params := map[string]any{"limit": importPage, "sortKey": "updated_at", "useStateDbOnly": true, "archived": st.Archived, "sourceKinds": []string{"cli", "vscode", "appServer", "exec"}}
	if st.Cursor != nil {
		params["cursor"] = *st.Cursor
	}
	raw, err := h.server.Request(ctx, "thread/list", params)
	if err != nil {
		return ImportPage{}, err
	}
	var page struct {
		Data       []codexThread `json:"data"`
		NextCursor *string       `json:"nextCursor"`
	}
	if json.Unmarshal(raw, &page) != nil || page.Data == nil {
		return ImportPage{}, errors.New("Codex returned an invalid history page")
	}
	out := ImportPage{}
	for _, t := range page.Data {
		if t.Ephemeral {
			continue
		}
		c, err := t.candidate()
		if err != nil {
			return ImportPage{}, err
		}
		out.Sessions = append(out.Sessions, c)
	}
	var next *state
	switch {
	case page.NextCursor != nil:
		next = &state{Archived: st.Archived, Cursor: page.NextCursor}
	case !st.Archived:
		next = &state{Archived: true}
	}
	if next != nil {
		data, _ := json.Marshal(next)
		encoded := base64.RawURLEncoding.EncodeToString(data)
		out.NextCursor = &encoded
	}
	return out, nil
}

func (h *codexHistory) read(ctx context.Context, id string) (nativeSession, error) {
	raw, err := h.server.Request(ctx, "thread/read", map[string]any{"threadId": id})
	if err != nil {
		return nativeSession{}, err
	}
	var read struct {
		Thread codexThread `json:"thread"`
	}
	if json.Unmarshal(raw, &read) != nil || read.Thread.ID != id {
		return nativeSession{}, errors.New("Codex history not found")
	}
	meta, err := read.Thread.candidate()
	if err != nil {
		return nativeSession{}, err
	}
	session := nativeSession{ImportCandidate: meta}
	created, _ := time.Parse(time.RFC3339, meta.CreatedAt)
	seen := map[string]bool{}
	cursor := ""
	for {
		params := map[string]any{"threadId": id, "limit": importPage, "sortDirection": "asc", "itemsView": "full"}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := h.server.Request(ctx, "thread/turns/list", params)
		if err != nil {
			return session, err
		}
		var page struct {
			Data []struct {
				Status    string           `json:"status"`
				StartedAt any              `json:"startedAt"`
				ItemsView string           `json:"itemsView"`
				Items     []map[string]any `json:"items"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if json.Unmarshal(raw, &page) != nil || page.Data == nil {
			return session, errors.New("Codex returned an invalid turn page")
		}
		for _, t := range page.Data {
			if t.ItemsView == "notLoaded" || t.ItemsView == "summary" {
				return session, errors.New("Codex returned incomplete history; update Codex and retry")
			}
			at, _ := time.Parse(time.RFC3339, isoUnix(t.StartedAt))
			if at.IsZero() {
				at = created
			}
			status := "completed"
			switch t.Status {
			case "failed":
				status = "failed"
			case "interrupted", "inProgress":
				status = "cancelled"
			}
			turn := nativeTurn{status: status, startedAt: at}
			for _, item := range t.Items {
				switch item["type"] {
				case "userMessage":
					content, _ := json.Marshal(item["content"])
					if text := blockText(content); text != "" {
						turn.user = strings.TrimSpace(strings.Join([]string{turn.user, text}, "\n"))
					}
				case "agentMessage":
					if text, _ := item["text"].(string); text != "" {
						turn.replies = append(turn.replies, text)
					}
				case "commandExecution":
					command, _ := item["command"].(string)
					output, _ := item["aggregatedOutput"].(string)
					turn.items = append(turn.items, map[string]any{"kind": "command", "status": "completed", "command": command, "output": output, "exit_code": item["exitCode"]})
				case "mcpToolCall":
					tool, _ := item["tool"].(string)
					server, _ := item["server"].(string)
					result, _ := json.Marshal(firstPresent(item["error"], item["result"], map[string]any{}))
					turn.items = append(turn.items, map[string]any{"kind": "tool_call", "status": "completed", "tool": tool, "server": server, "input": item["arguments"], "output": string(result)})
				}
			}
			session.turns = append(session.turns, turn)
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		if seen[*page.NextCursor] {
			return session, errors.New("Codex returned a repeated history cursor")
		}
		seen[*page.NextCursor] = true
		cursor = *page.NextCursor
	}
	return session, nil
}

func (h *codexHistory) fork(ctx context.Context, id, _ string) (string, error) {
	raw, err := h.server.Request(ctx, "thread/fork", map[string]any{"threadId": id})
	if err != nil {
		return "", err
	}
	var out struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	_ = json.Unmarshal(raw, &out)
	return out.Thread.ID, nil
}

// --- helpers ---

// blockText joins the text of message content: a string or text blocks.
// Images stay in the native session and are noted.
func blockText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []map[string]any
	_ = json.Unmarshal(raw, &blocks)
	var parts []string
	for _, b := range blocks {
		switch b["type"] {
		case "text", "input_text", "output_text":
			if t, _ := b["text"].(string); t != "" {
				parts = append(parts, t)
			}
		case "image", "localImage", "input_image":
			parts = append(parts, "[Image retained in native session context]")
		}
	}
	return strings.Join(parts, "\n")
}

func isoTime(v any, fallback string) string {
	switch v := v.(type) {
	case float64:
		return time.UnixMilli(int64(v)).UTC().Format(time.RFC3339)
	case string:
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return fallback
}

// isoUnix reads Codex times: seconds since the epoch, or RFC 3339.
func isoUnix(v any) string {
	if f, ok := v.(float64); ok {
		return time.Unix(int64(f), 0).UTC().Format(time.RFC3339)
	}
	return isoTime(v, "")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstPresent(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
