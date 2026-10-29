package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

var (
	// ErrTurnRunning rejects a send while the conversation already runs a turn.
	ErrTurnRunning = errors.New("local conversation: a turn is already running")
	// ErrOutcomeUnknown means the prompt may or may not have reached Claude;
	// the command must not be replayed automatically (plan §8.1).
	ErrOutcomeUnknown = errors.New("local conversation: provider outcome unknown")
)

// ClaudeAdapter is the running adapter process the runner talks to,
// implemented by *claude.Process.
type ClaudeAdapter interface {
	Request(ctx context.Context, typ string, fields map[string]any) (json.RawMessage, error)
	Close(ctx context.Context) error
	Done() <-chan struct{}
	Err() error
}

// AttachmentFiles writes attachment files, implemented by *store.Store.
type AttachmentFiles interface {
	WriteAttachmentFile(scopeID int64, conversationID, mediaType string, data []byte, now time.Time) (store.NewAttachment, error)
}

// StartClaudeAdapter launches an adapter delivering output to handler.
type StartClaudeAdapter func(ctx context.Context, handler claude.Handler) (ClaudeAdapter, error)

// ClaudeSession is how the conversation's adapter is started: the fields of
// the adapter start request, without resume, which the runner adds.
type ClaudeSession struct {
	Fields            map[string]any
	ProviderSessionID string
}

// SendRequest is one user turn.
type SendRequest struct {
	TurnID    string
	RequestID string
	// Fingerprint identifies the request content for idempotent retries.
	Fingerprint string
	MessageID   string
	// Text is the message as the user wrote it.
	Text string
	// Prompt is what the provider receives: Text plus attachment metadata.
	Prompt        string
	AttachmentIDs []string
	References    []Reference
	// Title, when set, becomes the conversation title with the message.
	Title *string
	// CreateTask is set when the message carries the New task mention.
	CreateTask bool
	// Hidden turns have no user message: the prompt comes from Multica,
	// such as a background result delivery.
	Hidden bool
}

func (r SendRequest) prompt() string {
	if r.Prompt != "" {
		return r.Prompt
	}
	return r.Text
}

const (
	interruptDeadline = 10 * time.Second
	previewRunes      = 200
)

// ClaudeRunner runs one Claude conversation: it starts the adapter on
// demand, records each turn through the batcher, normalizes adapter output
// into events, and completes the turn when Claude reports its result or the
// adapter goes away. Output handling never blocks the adapter reader.
type ClaudeRunner struct {
	rec            turnRecorder
	conversationID string
	start          StartClaudeAdapter
	session        ClaudeSession
	batcher        *Batcher
	limiter        *Limiter
	now            func() time.Time
	bindContext    ContextBinder
	onTurnEnd      func(turnID string)
	// onBackgroundEnded runs when background tasks end with no turn
	// running and no native reply started.
	onBackgroundEnded func(results []BackgroundResult)
	// taskTurns maps a background task item to the turn that started it;
	// later events of the task are recorded under that turn.
	taskTurns map[string]string
	// ended are background results waiting for delivery; a native reply
	// supersedes them.
	ended []BackgroundResult
	// stopped are tasks the user stopped; their end needs no follow-up.
	stopped map[string]bool
	// releaseContext ends the context route of the running adapter.
	releaseContext func()

	mu sync.Mutex
	// normMu serializes the normalizer between the adapter reader and
	// finish, which may run from the exit or interrupt path.
	normMu      sync.Mutex
	adapter     ClaudeAdapter
	norm        *claude.Normalizer
	turn        *claudeTurn
	contextName string
}

type claudeTurn struct {
	id              string
	cancelRequested bool
	// storageFailed is set when the batcher rejected output; the rest of
	// the turn's output is dropped and the turn ends as failed.
	storageFailed bool
	// lastMessageID is the uuid of the turn's last transcript message, where
	// a fork through this turn ends.
	lastMessageID string
	references    []Reference
	createTask    bool
	// unlimited marks a native turn that started over the concurrency
	// limit; it holds no limiter slot.
	unlimited bool
}

// BackgroundResult is a background task that ended after its turn.
type BackgroundResult struct {
	SourceTurnID string
	// State is the task's final item state.
	State map[string]any
}

// ClaudeRunnerOptions configures a runner.
type ClaudeRunnerOptions struct {
	ConversationID string
	ScopeID        int64
	Files          AttachmentFiles
	Start          StartClaudeAdapter
	Session        ClaudeSession
	Batcher        *Batcher
	Limiter        *Limiter
	ContextMCPName string
	Now            func() time.Time
	// OnTurnEnd, when set, runs after a turn's completion is recorded.
	OnTurnEnd func(turnID string)
	// OnBackgroundEnded, when set, receives background tasks that ended
	// while no turn ran.
	OnBackgroundEnded func(results []BackgroundResult)
	// Context, when set, gives the adapter Multica's context tools.
	Context ContextBinder
}

// NewClaudeRunner returns a runner for one conversation.
func NewClaudeRunner(opts ClaudeRunnerOptions) *ClaudeRunner {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &ClaudeRunner{
		rec:            turnRecorder{conversationID: opts.ConversationID, scopeID: opts.ScopeID, files: opts.Files, now: opts.Now},
		conversationID: opts.ConversationID, start: opts.Start, session: opts.Session,
		batcher: opts.Batcher, limiter: opts.Limiter, now: opts.Now, contextName: opts.ContextMCPName, bindContext: opts.Context,
		onTurnEnd: opts.OnTurnEnd, onBackgroundEnded: opts.OnBackgroundEnded,
		taskTurns: map[string]string{}, stopped: map[string]bool{},
	}
}

// Send starts a turn. It returns once the user input, turn start and command
// receipt are durable and the prompt was handed to the adapter; output and
// completion follow as events.
func (r *ClaudeRunner) Send(ctx context.Context, req SendRequest) error {
	r.mu.Lock()
	if r.turn != nil {
		r.mu.Unlock()
		return ErrTurnRunning
	}
	if err := r.limiter.TryAcquire(); err != nil {
		r.mu.Unlock()
		return err
	}
	turn := &claudeTurn{id: req.TurnID, references: req.References, createTask: req.CreateTask}
	r.turn = turn
	r.mu.Unlock()

	_, err := r.batcher.AppendWait(ctx, r.rec.startBatch(req))
	if err != nil {
		r.mu.Lock()
		r.turn = nil
		r.mu.Unlock()
		r.limiter.Release()
		return err
	}

	adapter, err := r.ensureAdapter(ctx)
	if err != nil {
		r.finish(turn, "failed", &turnError{kind: "provider_unavailable", message: err.Error()})
		return err
	}
	content := []map[string]any{{"type": "text", "text": req.prompt()}}
	if _, err := adapter.Request(ctx, "send", map[string]any{"request_id": req.RequestID, "content": content}); err != nil {
		var adapterErr *claude.AdapterError
		if errors.As(err, &adapterErr) && (adapterErr.Dispatch == "not_dispatched" || adapterErr.Dispatch == "rejected") {
			r.finish(turn, "failed", &turnError{kind: "provider_error", message: err.Error()})
			return err
		}
		// Anything else may have reached Claude: transport errors included.
		r.finish(turn, "failed", &turnError{kind: "outcome_unknown", message: err.Error()})
		return fmt.Errorf("%w: %w", ErrOutcomeUnknown, err)
	}
	return nil
}

// StopTasks asks Claude to stop background tasks. Without a running
// adapter there is nothing left to stop.
func (r *ClaudeRunner) StopTasks(ctx context.Context, taskIDs []string) error {
	r.mu.Lock()
	adapter := r.adapter
	r.mu.Unlock()
	if adapter == nil {
		return nil
	}
	r.mu.Lock()
	for _, id := range taskIDs {
		r.stopped[id] = true
	}
	r.mu.Unlock()
	var errs []error
	for _, id := range taskIDs {
		if _, err := adapter.Request(ctx, "stop_task", map[string]any{"task_id": id}); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Interrupt asks Claude to stop the running turn. The turn completes as
// cancelled when the adapter confirms or the Query ends.
func (r *ClaudeRunner) Interrupt(ctx context.Context) error {
	r.mu.Lock()
	turn, adapter := r.turn, r.adapter
	if turn != nil {
		turn.cancelRequested = true
	}
	r.mu.Unlock()
	if turn == nil || adapter == nil {
		return nil
	}
	data, err := adapter.Request(ctx, "interrupt", map[string]any{"deadline_ms": interruptDeadline.Milliseconds()})
	if err != nil {
		return err
	}
	var result struct {
		Outcome string `json:"outcome"`
	}
	_ = json.Unmarshal(data, &result)
	if result.Outcome == "closed" {
		// The Query transport was closed; no result will follow.
		r.finish(turn, "cancelled", nil)
	}
	return nil
}

// Close stops the adapter, failing a running turn.
func (r *ClaudeRunner) Close(ctx context.Context) error {
	r.mu.Lock()
	adapter, turn, release := r.adapter, r.turn, r.releaseContext
	r.adapter, r.releaseContext = nil, nil
	r.mu.Unlock()
	if turn != nil {
		r.finish(turn, "failed", &turnError{kind: "provider_exited", message: "the conversation was closed"})
	}
	if release != nil {
		release()
	}
	if adapter == nil {
		return nil
	}
	return adapter.Close(ctx)
}

func (r *ClaudeRunner) ensureAdapter(ctx context.Context) (ClaudeAdapter, error) {
	r.mu.Lock()
	if r.adapter != nil {
		a := r.adapter
		r.mu.Unlock()
		return a, nil
	}
	r.mu.Unlock()

	norm := claude.NewNormalizer(r.contextName)
	adapter, err := r.start(ctx, func(out claude.Output) { r.handle(norm, out) })
	if err != nil {
		return nil, err
	}
	fields := map[string]any{}
	for k, v := range r.session.Fields {
		fields[k] = v
	}
	r.mu.Lock()
	if id := r.session.ProviderSessionID; id != "" {
		fields["resume"] = id
	}
	r.mu.Unlock()
	release := func() {}
	if r.bindContext != nil {
		binding, rel, err := r.bindContext(context.Background(), "", r.currentContext)
		if err != nil {
			_ = adapter.Close(ctx)
			return nil, err
		}
		release = rel
		fields["mcp_servers"] = contextServerEntry(contextName(r.contextName), binding.Binding)
		if binding.SystemPrompt != "" {
			fields["append_system_prompt"] = binding.SystemPrompt
		}
		fields["allowed_tools"] = []string{"mcp__" + contextName(r.contextName) + "__*"}
	}
	if _, err := adapter.Request(ctx, "start", fields); err != nil {
		release()
		_ = adapter.Close(ctx)
		return nil, err
	}
	r.mu.Lock()
	r.adapter, r.norm, r.releaseContext = adapter, norm, release
	r.mu.Unlock()
	go r.watch(adapter)
	return adapter, nil
}

// watch fails the running turn when the adapter process goes away.
func (r *ClaudeRunner) watch(adapter ClaudeAdapter) {
	<-adapter.Done()
	r.mu.Lock()
	if r.adapter != adapter {
		r.mu.Unlock()
		return
	}
	r.adapter = nil
	turn, release := r.turn, r.releaseContext
	r.releaseContext = nil
	r.mu.Unlock()
	if release != nil {
		release()
	}
	if turn != nil {
		message := "Claude adapter exited"
		if err := adapter.Err(); err != nil {
			message = err.Error()
		}
		r.finish(turn, "failed", &turnError{kind: "provider_exited", message: message})
	}
}

// handle runs on the adapter's reader goroutine and must not block.
func (r *ClaudeRunner) handle(norm *claude.Normalizer, out claude.Output) {
	r.mu.Lock()
	turn := r.turn
	cancelRequested := turn != nil && turn.cancelRequested
	r.mu.Unlock()
	switch out.Type {
	case "sdk_message":
		r.normMu.Lock()
		events := norm.Accept(out.Message)
		sessionID := norm.SessionID()
		result := norm.TakeResult()
		r.normMu.Unlock()
		if sessionID != "" {
			r.rememberSession(sessionID)
		}
		events = r.routeTaskEvents(turn, events)
		if turn == nil && len(events) > 0 {
			// Claude replied on its own, e.g. to a task notification. A
			// bare result after a finished turn opens nothing.
			turn = r.startNativeTurn()
		}
		if turn != nil {
			if id := transcriptMessageID(out.Message); id != "" {
				r.mu.Lock()
				turn.lastMessageID = id
				r.mu.Unlock()
			}
			r.appendOutput(turn, events)
		}
		if result != nil && turn != nil {
			switch {
			case turn.storageFailed:
				r.finish(turn, "failed", &turnError{kind: "storage_limit", message: ErrStorageBacklog.Error()})
			case cancelRequested:
				r.finish(turn, "cancelled", nil)
			case result.IsError:
				r.finish(turn, "failed", &turnError{kind: "provider_error", message: result.Error})
			default:
				r.finish(turn, "completed", nil)
			}
		}
	case "error":
		if turn != nil {
			status := "failed"
			if cancelRequested {
				status = "cancelled"
			}
			r.finish(turn, status, &turnError{kind: "provider_exited", message: out.Error.Message})
		}
	}
}

func (r *ClaudeRunner) appendOutput(turn *claudeTurn, events []claude.Event) {
	if turn.storageFailed || len(events) == 0 {
		return
	}
	out := make([]outputEvent, len(events))
	for i, e := range events {
		out[i] = claudeOutput(e)
	}
	batch := r.rec.outputBatch(turn.id, out)
	if err := r.batcher.Append(batch, false); err != nil {
		r.mu.Lock()
		turn.storageFailed = true
		adapter := r.adapter
		r.mu.Unlock()
		if adapter != nil {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), interruptDeadline)
				defer cancel()
				_, _ = adapter.Request(ctx, "interrupt", map[string]any{"deadline_ms": interruptDeadline.Milliseconds()})
			}()
		}
	}
}

// finish completes turn once: open items get final events, then
// turn.completed and the turn row are committed together.
func (r *ClaudeRunner) finish(turn *claudeTurn, status string, failure *turnError) {
	r.mu.Lock()
	if r.turn != turn {
		r.mu.Unlock()
		return
	}
	r.turn = nil
	norm := r.norm
	r.mu.Unlock()
	if !turn.unlimited {
		defer r.limiter.Release()
	}

	itemStatus := status
	if itemStatus == "completed" {
		// A completed turn still closes items Claude never finished.
		itemStatus = "cancelled"
	}
	var finals []outputEvent
	if norm != nil {
		r.normMu.Lock()
		for _, e := range norm.Close(itemStatus) {
			finals = append(finals, claudeOutput(e))
		}
		r.normMu.Unlock()
	}
	// Critical: committed with the output before it, never rejected by the
	// pending budget.
	r.mu.Lock()
	lastMessageID := turn.lastMessageID
	r.mu.Unlock()
	_ = r.batcher.Append(r.rec.completionBatch(turn.id, lastMessageID, status, failure, finals), true)
	if r.onTurnEnd != nil {
		r.onTurnEnd(turn.id)
	}
}

func (r *ClaudeRunner) rememberSession(id string) {
	r.mu.Lock()
	changed := r.session.ProviderSessionID != id
	r.session.ProviderSessionID = id
	r.mu.Unlock()
	if changed {
		_ = r.batcher.Append(r.rec.sessionBatch(id), true)
	}
}

// ApplySettings changes the provider settings. A live adapter is updated in
// place; later adapter starts use the new values.
func (r *ClaudeRunner) ApplySettings(ctx context.Context, st store.ConversationSettings) error {
	r.mu.Lock()
	fields := map[string]any{}
	for k, v := range r.session.Fields {
		fields[k] = v
	}
	delete(fields, "model")
	delete(fields, "reasoning_effort")
	if st.Model != nil {
		fields["model"] = *st.Model
	}
	if st.ReasoningEffort != nil {
		fields["reasoning_effort"] = *st.ReasoningEffort
	}
	fields["permission_mode"] = st.PermissionMode
	r.session.Fields = fields
	adapter := r.adapter
	r.mu.Unlock()
	if adapter == nil {
		return nil
	}
	var model any
	if st.Model != nil {
		model = *st.Model
	}
	if _, err := adapter.Request(ctx, "set_model", map[string]any{"model": model}); err != nil {
		return err
	}
	var effort any
	if st.ReasoningEffort != nil {
		effort = *st.ReasoningEffort
	}
	if _, err := adapter.Request(ctx, "apply_flag_settings", map[string]any{"settings": map[string]any{"effortLevel": effort}}); err != nil {
		return err
	}
	_, err := adapter.Request(ctx, "set_permission_mode", map[string]any{"mode": st.PermissionMode})
	return err
}

func claudeOutput(e claude.Event) outputEvent {
	out := outputEvent{ItemID: e.ItemID, Type: e.Type, Final: e.Final, Payload: e.Payload}
	if e.Image != nil {
		out.ImageMime, out.ImageData = e.Image.MimeType, e.Image.Data
	}
	return out
}

// currentContext is what current_context reports while the adapter runs.
func (r *ClaudeRunner) currentContext() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	current := map[string]any{"conversation_id": r.rec.conversationID, "references": []Reference{}}
	if r.turn != nil {
		current["turn_id"], current["references"] = r.turn.id, r.turn.references
		current["create_task_requested"] = r.turn.createTask
	}
	return current
}

// contextName is the context MCP server name, defaulting to Multica's.
func contextName(name string) string {
	if name == "" {
		return contextmcp.Name
	}
	return name
}

// transcriptMessageID is the uuid of an SDK message that Claude keeps in
// its session transcript: user and assistant messages.
func transcriptMessageID(raw json.RawMessage) string {
	var m struct {
		Type string `json:"type"`
		UUID string `json:"uuid"`
	}
	if json.Unmarshal(raw, &m) != nil || (m.Type != "user" && m.Type != "assistant") {
		return ""
	}
	return m.UUID
}

// routeTaskEvents records events of background tasks started by another
// turn under that turn and returns the rest. A task's start in the
// current turn is remembered; a task's final event outside any turn is
// queued for delivery.
func (r *ClaudeRunner) routeTaskEvents(turn *claudeTurn, events []claude.Event) []claude.Event {
	var rest []claude.Event
	var ended []BackgroundResult
	r.mu.Lock()
	for _, e := range events {
		if e.Payload["kind"] != "background_task" {
			rest = append(rest, e)
			continue
		}
		owner, known := r.taskTurns[e.ItemID]
		if !known {
			if turn == nil {
				continue // a task this adapter never saw start
			}
			r.taskTurns[e.ItemID] = turn.id
			rest = append(rest, e)
			continue
		}
		if e.Final {
			delete(r.taskTurns, e.ItemID)
		}
		if turn != nil && owner == turn.id {
			rest = append(rest, e)
			continue
		}
		_ = r.batcher.Append(r.rec.outputBatch(owner, []outputEvent{claudeOutput(e)}), e.Final)
		if e.Final && turn == nil {
			taskID, _ := e.Payload["task_id"].(string)
			if !r.stopped[taskID] {
				ended = append(ended, BackgroundResult{SourceTurnID: owner, State: e.Payload})
			}
		}
	}
	r.ended = append(r.ended, ended...)
	pending := r.ended
	r.mu.Unlock()
	if len(ended) > 0 && r.onBackgroundEnded != nil {
		r.onBackgroundEnded(pending)
	}
	return rest
}

// TakeBackgroundResults returns and clears the results waiting for
// delivery.
func (r *ClaudeRunner) TakeBackgroundResults() []BackgroundResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.ended
	r.ended = nil
	return out
}

// startNativeTurn records a turn Claude started without a prompt from
// Multica. It answers any background results waiting for delivery.
func (r *ClaudeRunner) startNativeTurn() *claudeTurn {
	turn := &claudeTurn{id: "turn-native-" + newID()}
	turn.unlimited = r.limiter.TryAcquire() != nil
	r.mu.Lock()
	if r.turn != nil {
		existing := r.turn
		r.mu.Unlock()
		if !turn.unlimited {
			r.limiter.Release()
		}
		return existing
	}
	r.turn = turn
	r.ended = nil
	r.mu.Unlock()
	_ = r.batcher.Append(r.rec.startBatch(SendRequest{TurnID: turn.id, RequestID: turn.id, Hidden: true}), true)
	return turn
}
