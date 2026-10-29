package localhost

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/multica-ai/multica/server/internal/localconversation/service"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

// V2Version is the wire protocol served under /local/v2.
const V2Version = 2

const (
	v2MaxSubscriptions = 32
	v2WriteTimeout     = 10 * time.Second
	v2MaxBodyBytes     = 8 << 20
	v2PageLimit        = 200
)

// Scope headers name the caller's account and workspace on every v2 request.
const (
	headerAPIOrigin   = "X-Multica-API-Origin"
	headerUserID      = "X-Multica-User-ID"
	headerWorkspaceID = "X-Workspace-ID"
)

// V2 serves the Go-owned local conversation protocol (plan §5).
type V2 struct {
	svc        *service.Service
	token      string
	profileDir string
	upgrader   websocket.Upgrader
}

// NewV2 serves svc. Requests must carry token and the profile's account.
func NewV2(svc *service.Service, token, profileDir string) *V2 {
	return &V2{svc: svc, token: token, profileDir: profileDir, upgrader: websocket.Upgrader{
		ReadBufferSize: 64 << 10, WriteBufferSize: 64 << 10,
		CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" },
	}}
}

// Register mounts the v2 routes.
func (v *V2) Register(mux *http.ServeMux) { mux.Handle("/local/v2/", v) }

func (v *V2) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !Authorize(r, v.token) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/local/v2")
	if path == "/hello" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"version": V2Version, "store_generation": v.svc.Generation(), "capabilities": []string{"claude", "codex"}})
		return
	}
	scopeID, err := v.scope(r)
	if err != nil {
		writeV2Error(w, err)
		return
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case path == "/ws" && r.Method == http.MethodGet:
		v.serveWS(w, r, scopeID)
	case path == "/sessions" && r.Method == http.MethodGet:
		v.listSessions(w, r, scopeID)
	case path == "/sessions" && r.Method == http.MethodPost:
		v.createSession(w, r, scopeID)
	case len(parts) == 3 && parts[0] == "sessions" && parts[2] == "snapshot" && r.Method == http.MethodGet:
		v.snapshot(w, r, scopeID, parts[1])
	case len(parts) == 3 && parts[0] == "sessions" && parts[2] == "commands" && r.Method == http.MethodPost:
		v.command(w, r, scopeID, parts[1])
	default:
		http.NotFound(w, r)
	}
}

// scope resolves the caller's scope. The user must be the account Desktop
// last synced into this daemon profile, as for v1 session.set.
func (v *V2) scope(r *http.Request) (int64, error) {
	origin, user, workspace := r.Header.Get(headerAPIOrigin), r.Header.Get(headerUserID), r.Header.Get(headerWorkspaceID)
	if origin == "" || user == "" || workspace == "" {
		return 0, AppError("invalid_scope", "API origin, user and workspace headers are required")
	}
	data, err := os.ReadFile(filepath.Join(v.profileDir, desktopUserIDFile))
	if err != nil {
		return 0, AppError("not_signed_in", "Sign in to Multica Desktop to use local conversations")
	}
	if strings.TrimSpace(string(data)) != user {
		return 0, AppError("account_mismatch", "This daemon is in use by another account")
	}
	return v.svc.Store().EnsureScope(r.Context(), store.Scope{APIOrigin: origin, UserID: user, WorkspaceID: workspace})
}

func (v *V2) listSessions(w http.ResponseWriter, r *http.Request, scopeID int64) {
	after, _ := strconv.ParseInt(r.URL.Query().Get("after_scope_seq"), 10, 64)
	rows, scopeSeq, err := v.svc.Store().SummariesAfter(r.Context(), scopeID, after, v2PageLimit)
	if err != nil {
		writeV2Error(w, err)
		return
	}
	summaries := make([]map[string]any, len(rows))
	for i, row := range rows {
		summaries[i] = summaryDTO(row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"scope_seq": scopeSeq, "summaries": summaries, "has_more": len(rows) == v2PageLimit})
}

type createSessionBody struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	Title    string `json:"title"`
	Cwd      string `json:"cwd"`
}

func (v *V2) createSession(w http.ResponseWriter, r *http.Request, scopeID int64) {
	var body createSessionBody
	if err := decodeBody(r, &body); err != nil {
		writeV2Error(w, err)
		return
	}
	if body.ID == "" || (body.Provider != "claude" && body.Provider != "codex") {
		writeV2Error(w, AppError("invalid_request", "id and a supported provider are required"))
		return
	}
	scopeSeq, err := v.svc.Store().CreateConversation(r.Context(), store.NewConversation{
		ID: body.ID, ScopeID: scopeID, Provider: body.Provider, Title: body.Title, Cwd: body.Cwd, CreatedAt: time.Now(),
	})
	if err != nil {
		writeV2Error(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": body.ID, "scope_seq": scopeSeq})
}

func (v *V2) snapshot(w http.ResponseWriter, r *http.Request, scopeID int64, id string) {
	snap, err := v.svc.Snapshot(r.Context(), scopeID, id)
	if err != nil {
		writeV2Error(w, err)
		return
	}
	turns := make([]map[string]any, len(snap.Turns))
	for i, t := range snap.Turns {
		messages := make([]map[string]any, len(t.Messages))
		for j, m := range t.Messages {
			var attachments []string
			_ = json.Unmarshal([]byte(m.AttachmentIds), &attachments)
			messages[j] = map[string]any{"id": m.ID, "role": m.Role, "content": m.Content, "attachment_ids": attachments, "steered": m.Steered == 1, "failed": m.Failed == 1, "created_at": m.CreatedAt}
		}
		events := make([]map[string]any, len(t.Events))
		for j, e := range t.Events {
			events[j] = eventDTO(store.CommittedFromRow(e))
		}
		turn := map[string]any{"id": t.Turn.ID, "turn_index": t.Turn.TurnIndex, "request_id": t.Turn.RequestID, "status": t.Turn.Status, "started_at": t.Turn.StartedAt, "messages": messages, "events": events}
		if t.Turn.CompletedAt.Valid {
			turn["completed_at"] = t.Turn.CompletedAt.String
		}
		if t.Turn.ErrorKind != "" {
			turn["error"] = map[string]any{"kind": t.Turn.ErrorKind, "message": t.Turn.Error}
		}
		turns[i] = turn
	}
	pending := make([]map[string]any, len(snap.PendingInteractions))
	for i, in := range snap.PendingInteractions {
		pending[i] = map[string]any{"interaction_id": in.ID, "turn_id": in.TurnID, "kind": in.Kind, "request": json.RawMessage(in.Payload), "created_at": in.CreatedAt}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version": V2Version, "store_generation": v.svc.Generation(), "snapshot_seq": snap.SnapshotSeq,
		"conversation": summaryDTO(snap.Conversation), "turns": turns, "has_older_turns": snap.HasOlderTurns,
		"pending_interactions": pending,
	})
}

type commandBody struct {
	Type      string           `json:"type"`
	RequestID string           `json:"request_id"`
	Text      string           `json:"text"`
	Content   []map[string]any `json:"content"`
	// answer: the question and the user's answers by question id.
	InteractionID string          `json:"interaction_id"`
	Answer        json.RawMessage `json:"answer"`
	// update_settings: an absent field keeps its value, null resets it to
	// the provider default.
	Model           json.RawMessage `json:"model"`
	ReasoningEffort json.RawMessage `json:"reasoning_effort"`
	PermissionMode  *string         `json:"permission_mode"`
}

// optionalString decodes an update_settings field.
func optionalString(raw json.RawMessage) (value *string, clear bool, err error) {
	switch {
	case len(raw) == 0:
		return nil, false, nil
	case string(raw) == "null":
		return nil, true, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, false, AppError("invalid_request", "settings values must be strings or null")
	}
	return &s, false, nil
}

func (v *V2) command(w http.ResponseWriter, r *http.Request, scopeID int64, id string) {
	var body commandBody
	if err := decodeBody(r, &body); err != nil {
		writeV2Error(w, err)
		return
	}
	switch body.Type {
	case "send":
		if body.RequestID == "" {
			writeV2Error(w, AppError("invalid_request", "request_id is required"))
			return
		}
		result, err := v.svc.Send(r.Context(), service.SendCommand{ScopeID: scopeID, ConversationID: id, RequestID: body.RequestID, Text: body.Text, Content: body.Content})
		if err != nil {
			writeV2Error(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"turn_id": result.TurnID, "replayed": result.Replayed})
	case "answer":
		if body.InteractionID == "" {
			writeV2Error(w, AppError("invalid_request", "interaction_id is required"))
			return
		}
		if err := v.svc.Answer(r.Context(), scopeID, id, body.InteractionID, body.Answer, r.Header.Get(headerUserID)); err != nil {
			writeV2Error(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "answered"})
	case "update_settings":
		model, clearModel, err := optionalString(body.Model)
		if err != nil {
			writeV2Error(w, err)
			return
		}
		effort, clearEffort, err := optionalString(body.ReasoningEffort)
		if err != nil {
			writeV2Error(w, err)
			return
		}
		err = v.svc.UpdateSettings(r.Context(), scopeID, id, service.SettingsUpdate{
			Model: model, ClearModel: clearModel, ReasoningEffort: effort, ClearReasoningEffort: clearEffort, PermissionMode: body.PermissionMode,
		})
		if err != nil {
			writeV2Error(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "applied"})
	case "interrupt":
		if err := v.svc.Interrupt(r.Context(), scopeID, id); err != nil {
			writeV2Error(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"status": "requested"})
	default:
		writeV2Error(w, AppError("invalid_request", "unknown command type"))
	}
}

// --- WebSocket ---

type wsConn struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	subs    map[string]*service.Subscription
	scope   *service.ScopeSubscription
}

func (c *wsConn) send(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(v2WriteTimeout))
	return c.conn.WriteJSON(v)
}

type wsClientMessage struct {
	Version         int    `json:"version"`
	Type            string `json:"type"`
	ConversationID  string `json:"conversation_id"`
	AfterSeq        int64  `json:"after_seq"`
	AfterScopeSeq   int64  `json:"after_scope_seq"`
	StoreGeneration string `json:"store_generation"`
}

func (v *V2) serveWS(w http.ResponseWriter, r *http.Request, scopeID int64) {
	ws, err := v.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &wsConn{conn: ws, subs: map[string]*service.Subscription{}}
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		c.mu.Lock()
		for _, sub := range c.subs {
			sub.Close()
		}
		if c.scope != nil {
			c.scope.Close()
		}
		c.mu.Unlock()
		_ = ws.Close()
	}()
	ws.SetReadLimit(1 << 20)
	for {
		var msg wsClientMessage
		if err := ws.ReadJSON(&msg); err != nil {
			return
		}
		if msg.Version != V2Version {
			_ = c.send(statusMessage(msg.ConversationID, "rejected", 0, AppError("unsupported_version", "this daemon speaks local protocol v2")))
			return
		}
		switch msg.Type {
		case "subscribe":
			v.wsSubscribe(ctx, c, scopeID, msg)
		case "unsubscribe":
			c.mu.Lock()
			if sub := c.subs[msg.ConversationID]; sub != nil {
				sub.Close()
				delete(c.subs, msg.ConversationID)
			}
			c.mu.Unlock()
		case "subscribe_scope":
			v.wsSubscribeScope(ctx, c, scopeID, msg)
		}
	}
}

func (v *V2) wsSubscribe(ctx context.Context, c *wsConn, scopeID int64, msg wsClientMessage) {
	if msg.StoreGeneration != v.svc.Generation() {
		_ = c.send(statusMessage(msg.ConversationID, "snapshot_required", 0, nil))
		return
	}
	c.mu.Lock()
	if old := c.subs[msg.ConversationID]; old != nil {
		old.Close()
		delete(c.subs, msg.ConversationID)
	}
	full := len(c.subs) >= v2MaxSubscriptions
	c.mu.Unlock()
	if full {
		_ = c.send(statusMessage(msg.ConversationID, "rejected", 0, AppError("subscription_limit", "too many open conversations on this connection")))
		return
	}
	sub, high, err := v.svc.Subscribe(ctx, scopeID, msg.ConversationID, msg.AfterSeq)
	switch {
	case errors.Is(err, service.ErrSnapshotRequired):
		_ = c.send(statusMessage(msg.ConversationID, "snapshot_required", 0, nil))
		return
	case err != nil:
		_ = c.send(statusMessage(msg.ConversationID, "rejected", 0, err))
		return
	}
	c.mu.Lock()
	c.subs[msg.ConversationID] = sub
	c.mu.Unlock()
	_ = c.send(statusMessage(msg.ConversationID, "subscribed", high, nil))
	go func() {
		live := false
		for {
			events, err := sub.Next(ctx)
			if err != nil {
				if errors.Is(err, service.ErrResubscribe) {
					_ = c.send(statusMessage(msg.ConversationID, "resubscribe", 0, nil))
				}
				return
			}
			dtos := make([]map[string]any, len(events))
			for i, e := range events {
				dtos[i] = eventDTO(e)
			}
			if err := c.send(map[string]any{"version": V2Version, "type": "conversation.events", "conversation_id": msg.ConversationID,
				"from_seq": events[0].Seq, "to_seq": events[len(events)-1].Seq, "events": dtos}); err != nil {
				sub.Close()
				return
			}
			if !live && sub.Live() {
				live = true
				_ = c.send(statusMessage(msg.ConversationID, "live", events[len(events)-1].Seq, nil))
			}
		}
	}()
}

func (v *V2) wsSubscribeScope(ctx context.Context, c *wsConn, scopeID int64, msg wsClientMessage) {
	sub, high, err := v.svc.Hub().SubscribeScope(ctx, scopeID, msg.AfterScopeSeq)
	if err != nil {
		status := "rejected"
		if errors.Is(err, service.ErrSnapshotRequired) {
			status, err = "snapshot_required", nil
		}
		_ = c.send(statusMessage("", status, 0, err))
		return
	}
	c.mu.Lock()
	if c.scope != nil {
		c.scope.Close()
	}
	c.scope = sub
	c.mu.Unlock()
	_ = c.send(statusMessage("", "subscribed", high, nil))
	go func() {
		for {
			rows, err := sub.Next(ctx)
			if err != nil {
				if errors.Is(err, service.ErrResubscribe) {
					_ = c.send(statusMessage("", "resubscribe", 0, nil))
				}
				return
			}
			summaries := make([]map[string]any, len(rows))
			for i, row := range rows {
				summaries[i] = summaryDTO(row)
			}
			if err := c.send(map[string]any{"version": V2Version, "type": "scope.summaries", "scope_seq": rows[len(rows)-1].SummarySeq, "summaries": summaries}); err != nil {
				sub.Close()
				return
			}
		}
	}()
}

// --- wire conversion ---

func eventDTO(e store.CommittedEvent) map[string]any {
	dto := map[string]any{"seq": e.Seq, "type": e.Type, "final": e.Final, "created_at": e.CreatedAt.UTC().Format(time.RFC3339Nano),
		"payload": e.Payload, "turn_id": nil, "turn_seq": nil, "item_id": nil}
	if e.TurnID != "" {
		dto["turn_id"], dto["turn_seq"] = e.TurnID, e.TurnSeq
	}
	if e.ItemID != "" {
		dto["item_id"] = e.ItemID
	}
	return dto
}

func summaryDTO(c sqlitedb.Conversation) map[string]any {
	dto := map[string]any{
		"conversation_id": c.ID, "summary_seq": c.SummarySeq, "provider": c.Provider, "title": c.Title, "status": c.Status,
		"cwd": c.Cwd, "project_id": nil, "pinned": c.Pinned == 1, "archived": c.Archived == 1,
		"last_message_preview": c.LastMessagePreview, "pending_interactions": c.PendingInteractions, "queue_count": c.QueueCount,
		"updated_at": c.UpdatedAt,
	}
	if c.ProjectID.Valid {
		dto["project_id"] = c.ProjectID.String
	}
	if c.SideSourceID != "" {
		dto["side_source_id"] = c.SideSourceID
	}
	return dto
}

func statusMessage(conversationID, status string, highWater int64, err error) map[string]any {
	msg := map[string]any{"version": V2Version, "type": "subscription.status", "status": status}
	if conversationID != "" {
		msg["conversation_id"] = conversationID
	}
	if status == "subscribed" || status == "live" {
		msg["high_water"] = highWater
	}
	if err != nil {
		kind := appErrorCode(err)
		if kind == "" {
			kind = "internal"
			if errors.Is(err, store.ErrNotFound) {
				kind = "not_found"
			}
		}
		msg["error"] = map[string]any{"kind": kind, "message": err.Error()}
	}
	return msg
}

func decodeBody(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, v2MaxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return AppError("invalid_request", "request body is not valid JSON")
	}
	return nil
}

func writeV2Error(w http.ResponseWriter, err error) {
	status, code := http.StatusInternalServerError, "internal"
	switch {
	case appErrorCode(err) != "":
		code = appErrorCode(err)
		status = http.StatusBadRequest
		if code == "not_signed_in" || code == "account_mismatch" {
			status = http.StatusForbidden
		}
	case errors.Is(err, store.ErrNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, service.ErrRequestConflict):
		status, code = http.StatusConflict, "request_conflict"
	case errors.Is(err, service.ErrConcurrencyLimit):
		status, code = http.StatusTooManyRequests, "concurrency_limit"
	case errors.Is(err, service.ErrTurnRunning):
		status, code = http.StatusConflict, "turn_running"
	case errors.Is(err, service.ErrInteractionAnswered):
		status, code = http.StatusConflict, "already_answered"
	case errors.Is(err, service.ErrInteractionClosed):
		status, code = http.StatusConflict, "interaction_closed"
	case errors.Is(err, service.ErrInvalidSettings):
		status, code = http.StatusBadRequest, "invalid_settings"
	case errors.Is(err, service.ErrUnsupportedProvider):
		status, code = http.StatusBadRequest, "unsupported_provider"
	case errors.Is(err, service.ErrOutcomeUnknown):
		status, code = http.StatusAccepted, "outcome_unknown"
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"kind": code, "message": err.Error()}})
}

// appErrorCode returns the stable code of an AppError, or "".
func appErrorCode(err error) string {
	var rpcErr *RPCError
	if !errors.As(err, &rpcErr) {
		return ""
	}
	data, _ := rpcErr.Data.(map[string]string)
	return data["code"]
}
