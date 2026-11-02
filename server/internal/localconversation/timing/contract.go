// Package timing writes the daemon's local conversation timing records. A
// record holds identifiers, timings, counts and closed-enum classifications
// only: never prompts, payloads, working directories, raw error text or
// addresses. The contract is shared with packages/core/local-conversation/timing.ts
// through testdata/contract.json.
package timing

import (
	"regexp"
	"strings"
)

// Version is the record schema this package writes.
const Version = 2

// SourceDaemon names records this process writes.
const SourceDaemon = "daemon"

// Event values.
const (
	EventStart = "start"
	EventEnd   = "end"
	EventMark  = "mark"
)

// Send-path marks this daemon emits.
const (
	StageDaemonRequestReceived  = "daemon.request_received"
	StageQueueDispatch          = "queue.dispatch"
	StageTurnPersist            = "turn.persist"
	StageRunnerCreate           = "runner.create"
	StageRunnerLimiter          = "runner.limiter"
	StagePrepareWait            = "prepare.wait"
	StageProviderSpawn          = "provider.spawn"
	StageProviderHandshake      = "provider.handshake"
	StageProviderConfig         = "provider.config"
	StageContextBind            = "context.bind"
	StageModelResolve           = "model.resolve"
	StageThreadPrepare          = "thread.prepare"
	StageProviderTurnStart      = "provider.turn_start"
	StageAdapterSpawn           = "adapter.spawn"
	StageAdapterReady           = "adapter.ready"
	StageSDKLoad                = "sdk.load"
	StageQueryInit              = "query.init"
	StageProviderInputQueued    = "provider.input_queued"
	StageProviderFirstMessage   = "provider.first_message"
	StageProviderFirstReasoning = "provider.first_reasoning"
	StageProviderFirstText      = "provider.first_text"
	StageProviderFirstTool      = "provider.first_tool"
	StageBatcherFirstOutput     = "batcher.first_output_commit"
	StageHubFirstOutputPublish  = "hub.first_output_publish"
	StageWSFirstOutputWrite     = "ws.first_output_write"
	StageTurnFinished           = "turn.finished"
	StageTimingDropped          = "timing.dropped"
)

// Origin values: where a request came from.
const (
	OriginLocal   = "local"
	OriginP2P     = "p2p"
	OriginUnknown = "unknown"
)

// ClientKind values.
const (
	ClientDesktop = "desktop"
	ClientMobile  = "mobile"
	ClientUnknown = "unknown"
)

// Connection values: the stream's own connection, never device-level state.
const (
	ConnectionLoopback = "loopback"
	ConnectionDirect   = "direct"
	ConnectionRelayed  = "relayed"
	ConnectionUnknown  = "unknown"
)

// PrepareKind values.
const (
	PrepareHot       = "hot"
	PreparePreheated = "preheated"
	PrepareSpare     = "spare"
	PrepareCold      = "cold"
)

// TurnKind values. Background and native turns stay out of p50/p90 summaries.
const (
	TurnUser       = "user"
	TurnQueued     = "queued"
	TurnSteer      = "steer"
	TurnBackground = "background"
	TurnNative     = "native"
	TurnAgent      = "agent"
)

// Reason values.
const (
	ReasonStart            = "start"
	ReasonResume           = "resume"
	ReasonSkipped          = "skipped"
	ReasonLive             = "live"
	ReasonCatchUp          = "catch_up"
	ReasonConcurrencyLimit = "concurrency_limit"
)

var (
	stages = setOf(
		"gui.submit", "gui.first_output_applied", "gui.terminal_applied", "renderer.request", "renderer.first_output_received", "main.request",
		"queue.context", "turn.execute", "turn.result", "attachments.resolve",
		"context.prepare", "context.credentials", "context.mcp", "provider.lookup",
		"provider.sdk_ready", "provider.refresh", "provider.input_written", "provider.input_yielded",
		"provider.pool_admission", "provider.pool_wait", "provider.pool_create", "provider.pool_reused", "provider.bridge",
		"provider.thread_wait", "provider.thread_ready", "provider.thread_unload",
		"provider.first_stdout", "provider.first_stderr", "provider.first_event",
		"provider.first_output", "provider.tool", "provider.result", "provider.failure", "provider.retry",
		"title.generate", "title.persist", "user.question", "images.save", "context.dispose", "images.recover", "turn.save",

		"client.send", "client.pending_shown", "client.request",
		StageDaemonRequestReceived, StageQueueDispatch, StageTurnPersist,
		StageRunnerCreate, StageRunnerLimiter, StagePrepareWait,
		StageBatcherFirstOutput, StageHubFirstOutputPublish, StageWSFirstOutputWrite,
		"client.first_event_received", "client.first_event_applied", "client.first_commit",
		StageTurnFinished, "client.terminal_applied",
		StageProviderSpawn, StageProviderHandshake, StageProviderConfig, StageContextBind, StageModelResolve, StageThreadPrepare,
		StageProviderTurnStart, "provider.first_frame", StageProviderFirstReasoning, StageProviderFirstText, StageProviderFirstTool, "provider.exit",
		StageAdapterSpawn, StageAdapterReady, StageSDKLoad, StageQueryInit, "spare.claim", "mcp.set",
		StageProviderInputQueued, StageProviderFirstMessage, "provider.session_ready", "provider.first_thinking",
		"focus.changed", "preheat.requested", "preheat.cancelled", "preheat.started", "preheat.finished", "preheat.failed",
		"spare.created", "spare.claimed", "spare.rejected", "spare.discarded", "runner.evicted",
		"link.start", "link.ready", "link.registered", "link.stop",
		"registry.fetch", "peer.known", "peer.mdns_found",
		"peer.connect", "relay.reserve", "relay.connected", "relay.refused",
		"holepunch.start", "holepunch.success", "holepunch.failed",
		"connection.direct", "connection.relayed", "connection.lost", "network.changed",
		"tunnel.conn", "tunnel.stream_open", "proxy.request", "proxy.first_byte",
		"ws.ticket", "ws.hello", "ws.open", "ws.subscribe", "ws.subscribed", "ws.catch_up",
		"migrate.start", "migrate.stream_closed", "migrate.reconnected", "migrate.resubscribed",
		"ws.closed", "ws.retry", "ws.resubscribed",
		"link.request_sent", "link.request_received", "link.response_sent", "link.response_received", "link.event_sent", "link.event_received",
		"snapshot.request", "snapshot.server_read", "snapshot.first_byte", "snapshot.received", "snapshot.parsed", "snapshot.rendered",
		StageTimingDropped,
	)
	origins      = setOf(OriginLocal, OriginP2P, OriginUnknown)
	clientKinds  = setOf(ClientDesktop, ClientMobile, ClientUnknown)
	connections  = setOf(ConnectionLoopback, ConnectionDirect, ConnectionRelayed, ConnectionUnknown)
	providers    = setOf("codex", "claude")
	prepareKinds = setOf(PrepareHot, PreparePreheated, PrepareSpare, PrepareCold)
	turnKinds    = setOf(TurnUser, TurnQueued, TurnSteer, TurnBackground, TurnNative, TurnAgent)
	reasons      = setOf(ReasonStart, ReasonResume, ReasonSkipped, ReasonLive, ReasonCatchUp, ReasonConcurrencyLimit,
		"provider_unavailable", "provider_error", "provider_exited", "outcome_unknown",
		"storage_limit", "compaction_failed", "interrupt_unconfirmed", "remote_failed")
	outcomes = setOf("completed", "failed", "cancelled")
	failures = setOf("rate_limit", "authentication", "transport", "cancelled", "other")
	events   = setOf(EventStart, EventEnd, EventMark, "wait")

	identifier = regexp.MustCompile(`^[\w:.-]{1,160}$`)
	atPattern  = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`)

	rateLimited   = regexp.MustCompile(`(?i)429|rate.?limit|insufficient|quota|余额不足`)
	unauthorized  = regexp.MustCompile(`(?i)401|403|unauthorized|authentication|not signed in`)
	cancelledText = regexp.MustCompile(`(?i)abort|cancel`)
	transportText = regexp.MustCompile(`(?i)websocket|disconnect|ECONN|ETIMEDOUT|fetch failed|timeout|timed out|deadline exceeded`)
)

func setOf(values ...string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, v := range values {
		out[v] = true
	}
	return out
}

// Record is one line of daemon-timing.jsonl. Field names follow the
// camelCase of the existing timing records so one parser reads both.
type Record struct {
	Version        int    `json:"version"`
	Source         string `json:"source"`
	At             string `json:"at"`
	Stage          string `json:"stage"`
	Event          string `json:"event"`
	ElapsedMs      int64  `json:"elapsedMs"`
	ConversationID string `json:"conversationId,omitempty"`
	RequestID      string `json:"requestId,omitempty"`
	TurnID         string `json:"turnId,omitempty"`
	Provider       string `json:"provider,omitempty"`
	Background     bool   `json:"background,omitempty"`
	DurationMs     *int64 `json:"durationMs,omitempty"`
	Outcome        string `json:"outcome,omitempty"`
	Failure        string `json:"failure,omitempty"`
	Reason         string `json:"reason,omitempty"`
	Origin         string `json:"origin,omitempty"`
	ClientKind     string `json:"clientKind,omitempty"`
	Connection     string `json:"connection,omitempty"`
	PrepareKind    string `json:"prepareKind,omitempty"`
	TurnKind       string `json:"turnKind,omitempty"`
	TurnIndex      *int64 `json:"turnIndex,omitempty"`
	Attempt        *int64 `json:"attempt,omitempty"`
	PrepareID      string `json:"prepareId,omitempty"`
	Count          *int64 `json:"count,omitempty"`
}

// Sanitize returns r with unknown closed-enum values dropped, or false when
// r cannot be a valid record: an unknown stage or an identifier that could
// carry anything but an opaque id.
func Sanitize(r Record) (Record, bool) {
	if r.Version != Version || r.Source != SourceDaemon || !stages[r.Stage] || !events[r.Event] || !atPattern.MatchString(r.At) || r.ElapsedMs < 0 {
		return Record{}, false
	}
	for _, id := range []string{r.ConversationID, r.RequestID, r.TurnID} {
		if id != "" && !identifier.MatchString(id) {
			return Record{}, false
		}
	}
	r.Provider = closed(providers, r.Provider)
	r.Outcome = closed(outcomes, r.Outcome)
	r.Failure = closed(failures, r.Failure)
	r.Reason = closed(reasons, r.Reason)
	r.Origin = closed(origins, r.Origin)
	r.ClientKind = closed(clientKinds, r.ClientKind)
	r.Connection = closed(connections, r.Connection)
	r.PrepareKind = closed(prepareKinds, r.PrepareKind)
	r.TurnKind = closed(turnKinds, r.TurnKind)
	if r.PrepareID != "" && !identifier.MatchString(r.PrepareID) {
		r.PrepareID = ""
	}
	r.DurationMs = nonNegative(r.DurationMs)
	r.TurnIndex = nonNegative(r.TurnIndex)
	r.Attempt = nonNegative(r.Attempt)
	r.Count = nonNegative(r.Count)
	return r, true
}

func closed(set map[string]bool, value string) string {
	if set[value] {
		return value
	}
	return ""
}

func nonNegative(v *int64) *int64 {
	if v == nil || *v < 0 {
		return nil
	}
	return v
}

// Classify maps error text to a closed category without keeping the text,
// matching localTimingFailure on the TypeScript side.
func Classify(message string) string {
	switch {
	case rateLimited.MatchString(message):
		return "rate_limit"
	case unauthorized.MatchString(message):
		return "authentication"
	case cancelledText.MatchString(message):
		return "cancelled"
	case transportText.MatchString(message):
		return "transport"
	}
	return "other"
}

// IsModelOutput reports whether a committed event carries model output, as
// opposed to the user message and lifecycle events every turn commits first.
func IsModelOutput(eventType, kind string) bool {
	if !strings.HasPrefix(eventType, "item.") {
		return false
	}
	switch kind {
	case "", "error", "background_task":
		return false
	}
	return true
}
