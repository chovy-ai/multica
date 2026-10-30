package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/codex"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/pkg/codexappserver"
)

// CodexServer is a running app-server, implemented by *codex.Server.
type CodexServer interface {
	Request(ctx context.Context, method string, params any) (json.RawMessage, error)
	Respond(id int, result any)
	RespondError(id int, code int, message string)
	Stop()
	Done() <-chan struct{}
	Err() error
}

// StartCodexServer launches app-server delivering notifications and server
// requests to handler, with env added to its environment.
type StartCodexServer func(ctx context.Context, handler codex.Handler, env []string) (CodexServer, error)

// ContextTokenEnv carries the context MCP route token to app-server, which
// sends it as the bearer token; Codex configuration never holds the value.
const ContextTokenEnv = "MULTICA_CONTEXT_MCP_TOKEN"

// CodexSession is how the conversation runs Codex.
type CodexSession struct {
	Cwd string
	// ThreadID is the native thread to resume; empty starts a new one.
	ThreadID        string
	Model           *string
	ReasoningEffort *string
	PermissionMode  string
	// DeveloperInstructions are appended to Codex's own instructions.
	DeveloperInstructions string
}

// ErrNoRunningTurn rejects steering when no turn runs.
var ErrNoRunningTurn = errors.New("local conversation: no running turn")

const (
	threadSetupTimeout   = 60 * time.Second
	codexInterruptWait   = 15 * time.Second
	maxBufferedTurnFrame = 1000
)

// CodexRunner runs one Codex conversation on its own app-server process:
// it starts or resumes the native thread, records each turn, normalizes the
// active turn's notifications, and completes the turn on turn/completed or
// when the process goes away. Like the TypeScript host it has no approval
// surface: approval requests are declined, never treated as approved.
type CodexRunner struct {
	rec     turnRecorder
	start   StartCodexServer
	batcher *Batcher
	limiter *Limiter
	context string
	bind    ContextBinder
	// onTurnEnd runs after a turn's completion is recorded.
	onTurnEnd func(turnID string)

	mu      sync.Mutex
	session CodexSession
	server  CodexServer
	native  *codexNative
	turn    *codexTurn
	// contextURL is the running server's context route; empty without one.
	contextURL string
	// systemPrompt is the bound context's prompt, added to Codex's
	// developer instructions.
	systemPrompt   string
	releaseContext func()
}

type codexTurn struct {
	id           string
	threadID     string
	nativeTurnID string
	// normMu serializes the normalizer between the app-server reader and
	// finish, which may run from the exit or interrupt path.
	normMu          sync.Mutex
	norm            *codex.Normalizer
	buffered        []codexappserver.Frame
	cancelRequested bool
	// active is set by the turn's first frame: Codex rejects turn/interrupt
	// until the turn has started, so an earlier interrupt waits for it.
	active        bool
	interrupted   bool
	storageFailed bool
	references    []Reference
	createTask    bool
}

type codexNative struct {
	DeveloperInstructions string         `json:"developer_instructions"`
	Model                 string         `json:"model"`
	ReasoningEffort       string         `json:"model_reasoning_effort"`
	MCPServers            map[string]any `json:"mcp_servers"`
}

// CodexRunnerOptions configures a runner.
type CodexRunnerOptions struct {
	ConversationID string
	ScopeID        int64
	Files          AttachmentFiles
	Start          StartCodexServer
	Session        CodexSession
	Batcher        *Batcher
	Limiter        *Limiter
	ContextMCPName string
	Now            func() time.Time
	// OnTurnEnd, when set, runs after a turn's completion is recorded.
	OnTurnEnd func(turnID string)
	// Context, when set, gives app-server Multica's context tools.
	Context ContextBinder
}

// NewCodexRunner returns a runner for one conversation.
func NewCodexRunner(opts CodexRunnerOptions) *CodexRunner {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &CodexRunner{
		rec:   turnRecorder{conversationID: opts.ConversationID, scopeID: opts.ScopeID, files: opts.Files, now: opts.Now},
		start: opts.Start, batcher: opts.Batcher, limiter: opts.Limiter, context: contextName(opts.ContextMCPName), session: opts.Session,
		bind: opts.Context, onTurnEnd: opts.OnTurnEnd,
	}
}

// Send starts a turn; it returns once the input is durable and Codex
// accepted turn/start.
func (r *CodexRunner) Send(ctx context.Context, req SendRequest) error {
	r.mu.Lock()
	if r.turn != nil {
		r.mu.Unlock()
		return ErrTurnRunning
	}
	if err := r.limiter.TryAcquire(); err != nil {
		r.mu.Unlock()
		return err
	}
	turn := &codexTurn{id: req.TurnID, norm: codex.NewNormalizer(r.context), references: req.References, createTask: req.CreateTask}
	r.turn = turn
	r.mu.Unlock()

	if _, err := r.batcher.AppendWait(ctx, r.rec.startBatch(req)); err != nil {
		r.mu.Lock()
		r.turn = nil
		r.mu.Unlock()
		r.limiter.Release()
		return err
	}
	server, native, err := r.ensureServer(ctx)
	if err != nil {
		r.finish(turn, "failed", &turnError{kind: "provider_unavailable", message: err.Error()})
		return err
	}
	threadID, err := r.thread(ctx, server, native)
	if err != nil {
		r.finish(turn, "failed", &turnError{kind: "provider_error", message: err.Error()})
		return err
	}
	r.mu.Lock()
	turn.threadID = threadID
	effort := native.ReasoningEffort
	if r.session.ReasoningEffort != nil {
		effort = *r.session.ReasoningEffort
	}
	r.mu.Unlock()

	var effortParam any
	if effort != "" {
		effortParam = effort
	}
	raw, err := server.Request(ctx, "turn/start", map[string]any{
		"threadId": threadID, "effort": effortParam,
		"input": []map[string]any{{"type": "text", "text": req.prompt(), "text_elements": []any{}}},
	})
	if err != nil {
		if codex.IsClosed(err) || errors.Is(err, context.DeadlineExceeded) {
			r.finish(turn, "failed", &turnError{kind: "outcome_unknown", message: err.Error()})
			return fmt.Errorf("%w: %w", ErrOutcomeUnknown, err)
		}
		r.finish(turn, "failed", &turnError{kind: "provider_error", message: err.Error()})
		return err
	}
	var started struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(raw, &started) != nil || started.Turn.ID == "" {
		r.finish(turn, "failed", &turnError{kind: "provider_error", message: "Codex returned no turn ID"})
		return errors.New("codex returned no turn id")
	}
	// Only the turn/start response establishes the turn; replay frames that
	// arrived before it are filtered by turn id now.
	r.mu.Lock()
	turn.nativeTurnID = started.Turn.ID
	buffered := turn.buffered
	turn.buffered = nil
	r.mu.Unlock()
	for _, frame := range buffered {
		r.handle(frame)
	}
	return nil
}

// Interrupt asks Codex to stop the running turn. A turn Codex has not
// started yet is interrupted as soon as it starts. If Codex does not
// confirm in time, the process is stopped and the turn ends as cancelled.
func (r *CodexRunner) Interrupt(ctx context.Context) error {
	r.mu.Lock()
	turn, server := r.turn, r.server
	if turn == nil || turn.cancelRequested {
		r.mu.Unlock()
		return nil
	}
	turn.cancelRequested = true
	active := turn.active
	if active {
		turn.interrupted = true
	}
	r.mu.Unlock()
	if active {
		if err := r.interruptNative(ctx, turn, server); err != nil {
			r.mu.Lock()
			turn.cancelRequested, turn.interrupted = false, false
			r.mu.Unlock()
			return err
		}
	}
	if server != nil {
		go r.confirmInterrupt(turn, server)
	}
	return nil
}

func (r *CodexRunner) interruptNative(ctx context.Context, turn *codexTurn, server CodexServer) error {
	r.mu.Lock()
	threadID, nativeTurnID := turn.threadID, turn.nativeTurnID
	r.mu.Unlock()
	_, err := server.Request(ctx, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": nativeTurnID})
	return err
}

// confirmInterrupt stops the app-server when an interrupted turn is still
// running after codexInterruptWait.
func (r *CodexRunner) confirmInterrupt(turn *codexTurn, server CodexServer) {
	select {
	case <-time.After(codexInterruptWait):
		r.mu.Lock()
		stillRunning := r.turn == turn
		r.mu.Unlock()
		if stillRunning {
			server.Stop()
			r.finish(turn, "cancelled", &turnError{kind: "interrupt_unconfirmed", message: "Codex did not confirm interruption"})
		}
	case <-server.Done():
	}
}

// Steer adds input to the running turn.
func (r *CodexRunner) Steer(ctx context.Context, text string) error {
	r.mu.Lock()
	turn, server := r.turn, r.server
	var threadID, nativeTurnID string
	if turn != nil {
		threadID, nativeTurnID = turn.threadID, turn.nativeTurnID
	}
	r.mu.Unlock()
	if turn == nil || server == nil || nativeTurnID == "" {
		return ErrNoRunningTurn
	}
	_, err := server.Request(ctx, "turn/steer", map[string]any{"threadId": threadID, "expectedTurnId": nativeTurnID,
		"input": []map[string]any{{"type": "text", "text": text, "text_elements": []any{}}}})
	return err
}

// ApplySettings changes settings for the next turn; a running turn keeps
// the settings it started with.
func (r *CodexRunner) ApplySettings(_ context.Context, st store.ConversationSettings) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.session.Model, r.session.ReasoningEffort, r.session.PermissionMode = st.Model, st.ReasoningEffort, st.PermissionMode
	return nil
}

// Close stops app-server, failing a running turn.
func (r *CodexRunner) Close(context.Context) error {
	r.mu.Lock()
	server, turn, release := r.server, r.turn, r.releaseContext
	r.server, r.releaseContext = nil, nil
	r.mu.Unlock()
	if turn != nil {
		r.finish(turn, "failed", &turnError{kind: "provider_exited", message: "the conversation was closed"})
	}
	if server != nil {
		server.Stop()
	}
	if release != nil {
		release()
	}
	return nil
}

func (r *CodexRunner) ensureServer(ctx context.Context) (CodexServer, *codexNative, error) {
	r.mu.Lock()
	if r.server != nil {
		server, native := r.server, r.native
		r.mu.Unlock()
		return server, native, nil
	}
	cwd := r.session.Cwd
	r.mu.Unlock()

	var env []string
	token := ""
	if r.bind != nil {
		var err error
		if token, err = contextmcp.NewToken(); err != nil {
			return nil, nil, err
		}
		env = []string{ContextTokenEnv + "=" + token}
	}
	server, err := r.start(ctx, r.handle, env)
	if err != nil {
		return nil, nil, err
	}
	raw, err := server.Request(ctx, "config/read", map[string]any{"cwd": cwd, "includeLayers": false})
	if err != nil {
		server.Stop()
		return nil, nil, err
	}
	var result struct {
		Config codexNative `json:"config"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		server.Stop()
		return nil, nil, errors.New("invalid Codex configuration response")
	}
	if _, reserved := result.Config.MCPServers[r.context]; reserved {
		server.Stop()
		return nil, nil, fmt.Errorf("native Codex settings use the reserved Multica MCP name %s", r.context)
	}
	contextURL, release, systemPrompt := "", func() {}, ""
	if r.bind != nil {
		binding, rel, err := r.bind(context.Background(), token, r.currentContext)
		if err != nil {
			server.Stop()
			return nil, nil, err
		}
		contextURL, release, systemPrompt = binding.URL, rel, binding.SystemPrompt
	}
	r.mu.Lock()
	r.server, r.native, r.contextURL, r.releaseContext, r.systemPrompt = server, &result.Config, contextURL, release, systemPrompt
	r.mu.Unlock()
	go r.watch(server)
	return server, &result.Config, nil
}

// thread starts the conversation's native thread or resumes it.
func (r *CodexRunner) thread(ctx context.Context, server CodexServer, native *codexNative) (string, error) {
	r.mu.Lock()
	session := r.session
	r.mu.Unlock()

	model := native.Model
	if session.Model != nil {
		model = *session.Model
	}
	if session.ThreadID != "" && model == "" {
		// An explicit model keeps resume from restoring a previous effort.
		def, err := defaultModel(ctx, server)
		if err != nil {
			return "", err
		}
		model = def
	}
	// Native MCP servers stay disabled in local conversations.
	mcp := map[string]any{}
	for name := range native.MCPServers {
		mcp[name] = map[string]any{"enabled": false}
	}
	r.mu.Lock()
	contextURL := r.contextURL
	r.mu.Unlock()
	if contextURL != "" {
		mcp[r.context] = map[string]any{"url": contextURL, "bearer_token_env_var": ContextTokenEnv, "enabled": true, "required": true,
			"default_tools_approval_mode": "approve", "tool_timeout_sec": 3600}
	}
	config := map[string]any{"mcp_servers": mcp}
	if session.ReasoningEffort != nil {
		config["model_reasoning_effort"] = *session.ReasoningEffort
	}
	params := map[string]any{"cwd": session.Cwd, "config": config}
	if model != "" {
		params["model"] = model
	} else {
		params["model"] = nil
	}
	instructions := native.DeveloperInstructions
	r.mu.Lock()
	extra := []string{session.DeveloperInstructions, r.systemPrompt}
	r.mu.Unlock()
	for _, part := range extra {
		if part == "" {
			continue
		}
		if instructions != "" {
			instructions += "\n\n"
		}
		instructions += part
	}
	if instructions != "" {
		params["developerInstructions"] = instructions
	} else {
		params["developerInstructions"] = nil
	}
	switch session.PermissionMode {
	case "auto":
		params["approvalPolicy"], params["approvalsReviewer"], params["sandbox"] = "on-request", "auto_review", "workspace-write"
	case "full-access":
		params["approvalPolicy"], params["sandbox"] = "never", "danger-full-access"
	}
	method := "thread/start"
	if session.ThreadID != "" {
		method = "thread/resume"
		params["threadId"], params["excludeTurns"] = session.ThreadID, true
	}
	setupCtx, cancel := context.WithTimeout(ctx, threadSetupTimeout)
	defer cancel()
	raw, err := server.Request(setupCtx, method, params)
	if err != nil {
		return "", err
	}
	var result struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Thread.ID == "" {
		return "", errors.New("codex returned no thread id")
	}
	if result.Thread.ID != session.ThreadID {
		r.mu.Lock()
		r.session.ThreadID = result.Thread.ID
		r.mu.Unlock()
		_ = r.batcher.Append(r.rec.sessionBatch(result.Thread.ID), true)
	}
	return result.Thread.ID, nil
}

func defaultModel(ctx context.Context, server CodexServer) (string, error) {
	raw, err := server.Request(ctx, "model/list", map[string]any{"limit": 100})
	if err != nil {
		return "", err
	}
	var list struct {
		Data []struct {
			ID        string `json:"id"`
			IsDefault bool   `json:"isDefault"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &list)
	for _, m := range list.Data {
		if m.IsDefault && m.ID != "" {
			return m.ID, nil
		}
	}
	return "", errors.New("could not resolve the default Codex model; select a model explicitly and retry")
}

// handle runs on the app-server reader and must not block.
func (r *CodexRunner) handle(frame codexappserver.Frame) {
	var p struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
		Turn     struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
	}
	_ = json.Unmarshal(frame.Params, &p)

	r.mu.Lock()
	turn, server := r.turn, r.server
	if turn == nil || p.ThreadID == "" || p.ThreadID != turn.threadID {
		r.mu.Unlock()
		if frame.Kind == codexappserver.FrameServerRequest && server != nil {
			declineCodexRequest(server, frame)
		}
		return
	}
	if turn.nativeTurnID == "" {
		if len(turn.buffered) < maxBufferedTurnFrame {
			turn.buffered = append(turn.buffered, frame)
		}
		r.mu.Unlock()
		return
	}
	cancelRequested, storageFailed, nativeTurnID := turn.cancelRequested, turn.storageFailed, turn.nativeTurnID
	if (p.TurnID != "" && p.TurnID != nativeTurnID) || (p.Turn.ID != "" && p.Turn.ID != nativeTurnID) {
		r.mu.Unlock()
		if frame.Kind == codexappserver.FrameServerRequest && server != nil {
			declineCodexRequest(server, frame)
		}
		return
	}
	turn.active = true
	interrupt := cancelRequested && !turn.interrupted && frame.Method != "turn/completed"
	if interrupt {
		turn.interrupted = true
	}
	r.mu.Unlock()
	if interrupt {
		// handle must not block the reader; confirmInterrupt, started by
		// Interrupt, ends the turn if this request fails.
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), codexInterruptWait)
			defer cancel()
			_ = r.interruptNative(ctx, turn, server)
		}()
	}

	if frame.Kind == codexappserver.FrameServerRequest {
		declineCodexRequest(server, frame)
		r.appendOutput(turn, []outputEvent{{ItemID: fmt.Sprintf("declined:%d", frame.ID), Type: "item.completed", Final: true, Payload: map[string]any{
			"kind": "error", "status": "failed", "error": map[string]any{"kind": "interaction_unsupported", "message": "Codex requested interactive input; this request was declined"},
		}}})
		return
	}
	if frame.Method == "turn/completed" {
		switch {
		case storageFailed:
			r.finish(turn, "failed", &turnError{kind: "storage_limit", message: ErrStorageBacklog.Error()})
		case p.Turn.Status == "completed":
			r.finish(turn, "completed", nil)
		case p.Turn.Status == "interrupted" || cancelRequested:
			r.finish(turn, "cancelled", nil)
		default:
			message := "Codex turn failed"
			if p.Turn.Error != nil && p.Turn.Error.Message != "" {
				message = p.Turn.Error.Message
			}
			r.finish(turn, "failed", &turnError{kind: "provider_error", message: message})
		}
		return
	}
	turn.normMu.Lock()
	events := turn.norm.Accept(frame.Method, frame.Params)
	turn.normMu.Unlock()
	out := make([]outputEvent, len(events))
	for i, e := range events {
		out[i] = codexOutput(e)
	}
	r.appendOutput(turn, out)
}

func (r *CodexRunner) appendOutput(turn *codexTurn, events []outputEvent) {
	r.mu.Lock()
	failed := turn.storageFailed
	r.mu.Unlock()
	if failed || len(events) == 0 {
		return
	}
	if err := r.batcher.Append(r.rec.outputBatch(turn.id, events), false); err != nil {
		r.mu.Lock()
		turn.storageFailed = true
		server, threadID, nativeTurnID := r.server, turn.threadID, turn.nativeTurnID
		r.mu.Unlock()
		if server != nil && nativeTurnID != "" {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), interruptDeadline)
				defer cancel()
				_, _ = server.Request(ctx, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": nativeTurnID})
			}()
		}
	}
}

func (r *CodexRunner) watch(server CodexServer) {
	<-server.Done()
	r.mu.Lock()
	if r.server != server {
		r.mu.Unlock()
		return
	}
	r.server, r.native, r.contextURL = nil, nil, ""
	turn, release := r.turn, r.releaseContext
	r.releaseContext = nil
	r.mu.Unlock()
	if release != nil {
		release()
	}
	if turn != nil {
		message := "Codex app-server exited"
		if err := server.Err(); err != nil {
			message = err.Error()
		}
		r.finish(turn, "failed", &turnError{kind: "provider_exited", message: message})
	}
}

// finish completes turn once, with finals for items it left open.
func (r *CodexRunner) finish(turn *codexTurn, status string, failure *turnError) {
	r.mu.Lock()
	if r.turn != turn {
		r.mu.Unlock()
		return
	}
	r.turn = nil
	r.mu.Unlock()
	defer r.limiter.Release()
	itemStatus := status
	if itemStatus == "completed" {
		itemStatus = "cancelled"
	}
	var finals []outputEvent
	turn.normMu.Lock()
	for _, e := range turn.norm.Close(itemStatus) {
		finals = append(finals, codexOutput(e))
	}
	turn.normMu.Unlock()
	_ = r.batcher.Append(r.rec.completionBatch(turn.id, turn.nativeTurnID, status, failure, finals), true)
	if r.onTurnEnd != nil {
		r.onTurnEnd(turn.id)
	}
}

// declineCodexRequest answers a server request without approving it.
func declineCodexRequest(server CodexServer, frame codexappserver.Frame) {
	switch frame.Method {
	case "item/permissions/requestApproval":
		server.Respond(frame.ID, map[string]any{"permissions": map[string]any{}, "scope": "turn"})
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		server.Respond(frame.ID, map[string]any{"decision": "cancel"})
	case "mcpServer/elicitation/request":
		server.Respond(frame.ID, map[string]any{"action": "cancel", "content": nil})
	default:
		server.RespondError(frame.ID, -32601, "unsupported request: "+frame.Method)
	}
}

func codexOutput(e codex.Event) outputEvent {
	out := outputEvent{ItemID: e.ItemID, Type: e.Type, Final: e.Final, Payload: e.Payload}
	if e.Image != nil {
		out.ImageMime, out.ImageData = e.Image.MimeType, e.Image.Data
	}
	return out
}

// currentContext is what current_context reports while app-server runs.
func (r *CodexRunner) currentContext() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	current := map[string]any{"conversation_id": r.rec.conversationID, "references": []Reference{}}
	if r.turn != nil {
		current["turn_id"], current["references"] = r.turn.id, r.turn.references
		current["create_task_requested"] = r.turn.createTask
	}
	return current
}

// StopTasks is a no-op: Codex reports no background tasks.
func (r *CodexRunner) StopTasks(context.Context, []string) error { return nil }

// Running reports whether a turn is in progress.
func (r *CodexRunner) Running() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.turn != nil
}
