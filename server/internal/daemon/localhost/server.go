package localhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// APIVersion is the Desktop ↔ daemon Local API protocol version.
const APIVersion = 1

const (
	eventBufferSize   = 1024
	hostRequestTTL    = 90 * time.Second
	maxUploadBytes    = 25 << 20
	desktopUserIDFile = ".desktop-user-id"
)

// Config wires a Server. A nil Sidecar means this daemon cannot host local
// conversations; the API then answers hello and nothing else.
type Config struct {
	Sidecar    *Sidecar
	Command    Command // defaults to SidecarCommand(*Sidecar)
	DataDir    string
	ProfileDir string
	CLIPath    string
	Token      string
	Logger     *slog.Logger
}

// Scope selects one account's conversations in one workspace.
type Scope struct {
	APIURL      string `json:"apiUrl"`
	UserID      string `json:"userId"`
	WorkspaceID string `json:"workspaceId"`
}

type eventRecord struct {
	seq   uint64
	event json.RawMessage
}

type client struct {
	id         string
	conn       *Conn
	mu         sync.Mutex
	userID     string
	subscribed bool
}

func (c *client) user() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.userID
}

type hostRequest struct {
	id       string
	clientID string
	kind     string
	payload  json.RawMessage
	reply    chan hostReply
}

type hostReply struct {
	result json.RawMessage
	err    *RPCError
}

// Server is the loopback Local API. It is safe for concurrent use.
type Server struct {
	cfg      Config
	sup      *supervisor
	upgrader websocket.Upgrader

	mu           sync.Mutex
	clients      map[string]*client
	ringInstance string
	ring         []eventRecord
	hostPending  map[string]*hostRequest
	lastReady    string
}

// NewServer builds the API. It never starts the sidecar; the first client
// that needs it does.
func NewServer(cfg Config) *Server {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	s := &Server{
		cfg:         cfg,
		clients:     map[string]*client{},
		hostPending: map[string]*hostRequest{},
		upgrader: websocket.Upgrader{
			ReadBufferSize:  64 << 10,
			WriteBufferSize: 64 << 10,
			// Authorize already rejected any request carrying an Origin.
			CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" },
		},
	}
	if cfg.Sidecar != nil {
		cmd := cfg.Command
		if cmd.Path == "" {
			cmd = SidecarCommand(*cfg.Sidecar)
		}
		s.sup = newSupervisor(cmd, InitParams{
			ProtocolVersion: cfg.Sidecar.ProtocolVersion,
			DataDir:         cfg.DataDir,
			ProfileDir:      cfg.ProfileDir,
			CLIPath:         cfg.CLIPath,
		}, supervisorHooks{handle: s.handleSidecar, status: s.onSidecarStatus, wantRestart: s.hasClients}, cfg.Logger)
	}
	return s
}

// Supported reports whether this daemon can host local conversations.
func (s *Server) Supported() bool { return s.sup != nil }

// Busy is the work a restart would interrupt right now.
func (s *Server) Busy() int64 {
	if s.sup == nil {
		return 0
	}
	return s.sup.Busy()
}

// Drain stops new local work and reports what is still running. Call Undrain
// when the caller decides not to restart after all.
func (s *Server) Drain(ctx context.Context) (int64, error) {
	if s.sup == nil {
		return 0, nil
	}
	return s.sup.Drain(ctx)
}

func (s *Server) Undrain(ctx context.Context) error {
	if s.sup == nil {
		return nil
	}
	return s.sup.Undrain(ctx)
}

// Close stops the sidecar and disconnects every client.
func (s *Server) Close(ctx context.Context) error {
	var err error
	if s.sup != nil {
		err = s.sup.Stop(ctx)
	}
	s.mu.Lock()
	clients := make([]*client, 0, len(s.clients))
	for _, c := range s.clients {
		clients = append(clients, c)
	}
	s.mu.Unlock()
	for _, c := range clients {
		_ = c.conn.Close()
	}
	return err
}

// Register mounts the API under /local/v1/.
func (s *Server) Register(mux *http.ServeMux) {
	mux.Handle("/local/v1/", s)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !Authorize(r, s.cfg.Token) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/local/v1")
	switch {
	case path == "/hello" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, s.hello())
	case path == "/ws" && r.Method == http.MethodGet:
		s.serveWS(w, r)
	case path == "/files" && r.Method == http.MethodPost:
		s.uploadFile(w, r)
	case strings.HasPrefix(path, "/files/") && r.Method == http.MethodGet:
		s.readFile(w, r, strings.TrimPrefix(path, "/files/"))
	default:
		http.NotFound(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeAppError(w http.ResponseWriter, status int, err error) {
	var rpcErr *RPCError
	if !errors.As(err, &rpcErr) {
		rpcErr = &RPCError{Code: rpcInternal, Message: err.Error()}
	}
	writeJSON(w, status, map[string]any{"error": rpcErr})
}

// Hello is the pre-WebSocket version and capability probe.
type Hello struct {
	APIVersion             int           `json:"apiVersion"`
	SidecarProtocolVersion int           `json:"sidecarProtocolVersion"`
	Capabilities           []string      `json:"capabilities"`
	Sidecar                SidecarReport `json:"sidecar"`
}

type SidecarReport struct {
	Status   SidecarStatus `json:"status"`
	Instance string        `json:"instance"`
	Busy     int64         `json:"busy"`
	Crashes  int64         `json:"crashes"`
}

func (s *Server) hello() Hello {
	if s.sup == nil {
		return Hello{APIVersion: APIVersion, Capabilities: []string{}, Sidecar: SidecarReport{Status: StatusUnsupported}}
	}
	status, instance := s.sup.Status()
	return Hello{
		APIVersion:             APIVersion,
		SidecarProtocolVersion: s.cfg.Sidecar.ProtocolVersion,
		Capabilities:           []string{"ws", "files", "drain"},
		Sidecar:                SidecarReport{Status: status, Instance: instance, Busy: s.sup.Busy(), Crashes: s.sup.Crashes()},
	}
}

func (s *Server) hasClients() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.clients) > 0
}

func (s *Server) broadcast(method string, params any, subscribedOnly bool) {
	s.mu.Lock()
	targets := make([]*client, 0, len(s.clients))
	for _, c := range s.clients {
		c.mu.Lock()
		if !subscribedOnly || c.subscribed {
			targets = append(targets, c)
		}
		c.mu.Unlock()
	}
	s.mu.Unlock()
	for _, c := range targets {
		_ = c.conn.Notify(method, params)
	}
}

func (s *Server) onSidecarStatus(status SidecarStatus, instance string) {
	s.broadcast("sidecarStatus", SidecarStatusNotification{Status: status, Instance: instance}, false)
	if status != StatusReady {
		return
	}
	s.mu.Lock()
	previous := s.lastReady
	s.lastReady = instance
	s.mu.Unlock()
	// A replacement instance invalidates every client's view of the data.
	if previous != "" && previous != instance {
		s.broadcast("resync", ResyncNotification{Instance: instance}, true)
	}
}

// --- WebSocket ---

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	ws, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{id: newInstanceID()}
	c.conn = NewConn(newWSTransport(ws), func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		return s.handleClient(ctx, c, method, params)
	})
	s.mu.Lock()
	s.clients[c.id] = c
	clientCount := len(s.clients)
	s.mu.Unlock()
	s.cfg.Logger.Info("local conversation client connected", "connection_id", c.id, "clients", clientCount)
	go func() {
		<-c.conn.Done()
		s.dropClient(c)
	}()
}

func (s *Server) dropClient(c *client) {
	s.mu.Lock()
	delete(s.clients, c.id)
	var orphaned []*hostRequest
	for _, req := range s.hostPending {
		if req.clientID == c.id {
			orphaned = append(orphaned, req)
		}
	}
	clientCount := len(s.clients)
	s.mu.Unlock()
	s.cfg.Logger.Info("local conversation client disconnected", "connection_id", c.id, "clients", clientCount, "pending_host_requests", len(orphaned))
	for _, req := range orphaned {
		select {
		case req.reply <- hostReply{err: AppError("settings_host_unavailable", "The desktop that received this request disconnected")}:
		default:
		}
	}
}

func decode[T any](params json.RawMessage) (T, error) {
	var v T
	if err := json.Unmarshal(params, &v); err != nil {
		return v, &RPCError{Code: rpcInvalidRequest, Message: "invalid params: " + err.Error()}
	}
	return v, nil
}

func (s *Server) requireSidecar(ctx context.Context) (*Conn, error) {
	if s.sup == nil {
		return nil, AppError("unsupported", "Local conversations require the daemon bundled with Multica Desktop")
	}
	return s.sup.Ensure(ctx)
}

func (s *Server) handleClient(ctx context.Context, c *client, method string, params json.RawMessage) (any, error) {
	switch method {
	case "session.set":
		p, err := decode[SessionParams](params)
		if err != nil {
			return nil, err
		}
		if err := s.checkProfileUser(p.UserID); err != nil {
			return nil, err
		}
		conn, err := s.requireSidecar(ctx)
		if err != nil {
			return nil, err
		}
		if err := conn.Call(ctx, "session.set", SidecarSessionParams{ConnectionID: c.id, UserID: p.UserID, APIURL: p.APIURL, Env: p.Env, LegacyDataDir: p.LegacyDataDir}, nil); err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.userID = p.UserID
		c.mu.Unlock()
		status, instance := s.sup.Status()
		s.cfg.Logger.Info("local conversation client session initialized", "connection_id", c.id, "instance", instance, "status", status)
		return SessionResult{ConnectionID: c.id, Status: status, Instance: instance}, nil
	case "subscribe":
		p, err := decode[SubscribeParams](params)
		if err != nil {
			return nil, err
		}
		return s.subscribe(c, p.Since), nil
	case "request":
		p, err := decode[RequestParams](params)
		if err != nil {
			return nil, err
		}
		if user := c.user(); user == "" || user != p.Scope.UserID {
			return nil, AppError("account_mismatch", "Call session.set for this account before sending requests")
		}
		conn, err := s.requireSidecar(ctx)
		if err != nil {
			return nil, err
		}
		return conn.CallRaw(ctx, "request", SidecarRequestParams{ConnectionID: c.id, Scope: p.Scope, Method: p.Method, Params: p.Params})
	case "hostReply":
		p, err := decode[HostReplyParams](params)
		if err != nil {
			return nil, err
		}
		return nil, s.resolveHostRequest(c, p.ID, hostReply{result: p.Result, err: p.Error})
	case "sidecar.drain":
		busy, err := s.Drain(ctx)
		return DrainResult{Busy: busy}, err
	case "sidecar.undrain":
		return map[string]any{}, s.Undrain(ctx)
	case "sidecar.stop":
		if s.sup == nil {
			return map[string]any{}, nil
		}
		return map[string]any{}, s.sup.Stop(ctx)
	}
	return nil, &RPCError{Code: rpcMethodNotFound, Message: "method not found: " + method}
}

// checkProfileUser keeps one daemon profile serving one account: the account
// Desktop last synced into this profile.
func (s *Server) checkProfileUser(userID string) error {
	data, err := os.ReadFile(filepath.Join(s.cfg.ProfileDir, desktopUserIDFile))
	if err != nil {
		return AppError("not_signed_in", "Sign in to Multica Desktop to use local conversations")
	}
	if strings.TrimSpace(string(data)) != userID {
		return AppError("account_mismatch", "This daemon is in use by another account")
	}
	return nil
}

func formatCursor(instance string, seq uint64) string {
	return instance + ":" + strconv.FormatUint(seq, 10)
}

// subscribe replays what the client missed when the buffer still covers it;
// otherwise the client must resynchronize from list/read.
func (s *Server) subscribe(c *client, since string) SubscribeResult {
	s.mu.Lock()
	c.mu.Lock()
	c.subscribed = true
	c.mu.Unlock()
	instance := s.ringInstance
	var replay []eventRecord
	resync := false
	if since != "" {
		inst, seqText, ok := strings.Cut(since, ":")
		seq, err := strconv.ParseUint(seqText, 10, 64)
		switch {
		case !ok || err != nil || inst != instance:
			resync = true
		case len(s.ring) > 0 && s.ring[0].seq > seq+1:
			resync = true
		default:
			for _, rec := range s.ring {
				if rec.seq > seq {
					replay = append(replay, rec)
				}
			}
		}
	}
	var pending []*hostRequest
	for _, req := range s.hostPending {
		if req.clientID == c.id {
			pending = append(pending, req)
		}
	}
	cursor := ""
	if len(s.ring) > 0 {
		cursor = formatCursor(instance, s.ring[len(s.ring)-1].seq)
	}
	s.mu.Unlock()

	if resync {
		_ = c.conn.Notify("resync", ResyncNotification{Instance: instance})
	}
	for _, rec := range replay {
		_ = c.conn.Notify("event", EventNotification{Cursor: formatCursor(instance, rec.seq), Event: rec.event})
	}
	for _, req := range pending {
		_ = c.conn.Notify("hostRequest", HostRequestNotification{ID: req.id, Kind: req.kind, Payload: req.payload})
	}
	return SubscribeResult{Cursor: cursor, Resync: resync}
}

// --- sidecar → daemon ---

func (s *Server) handleSidecar(ctx context.Context, instance, method string, params json.RawMessage) (any, error) {
	switch method {
	case "event":
		p, err := decode[SidecarEventParams](params)
		if err != nil {
			return nil, err
		}
		s.recordEvent(instance, p.Seq, p.Event)
		return nil, nil
	case "timing":
		s.broadcast("timing", json.RawMessage(params), true)
		return nil, nil
	case "log":
		p, _ := decode[LogParams](params)
		attrs := []any{}
		for k, v := range p.Fields {
			attrs = append(attrs, k, v)
		}
		level := slog.LevelInfo
		_ = level.UnmarshalText([]byte(p.Level))
		s.cfg.Logger.Log(ctx, level, "local host: "+p.Message, attrs...)
		return nil, nil
	case "host.request":
		p, err := decode[HostRequestParams](params)
		if err != nil {
			return nil, err
		}
		return s.hostRequest(ctx, p.ConnectionID, p.Kind, p.Payload)
	}
	return nil, &RPCError{Code: rpcMethodNotFound, Message: "method not found: " + method}
}

func (s *Server) recordEvent(instance string, seq uint64, event json.RawMessage) {
	s.mu.Lock()
	if s.ringInstance != instance {
		s.ringInstance = instance
		s.ring = s.ring[:0]
	}
	s.ring = append(s.ring, eventRecord{seq: seq, event: event})
	if len(s.ring) > eventBufferSize {
		s.ring = append(s.ring[:0], s.ring[len(s.ring)-eventBufferSize:]...)
	}
	s.mu.Unlock()
	s.broadcast("event", EventNotification{Cursor: formatCursor(instance, seq), Event: event}, true)
}

// hostRequest delivers a request to exactly the connection that originated
// the work and waits for its reply. It fails fast when that connection is gone.
func (s *Server) hostRequest(ctx context.Context, connectionID, kind string, payload json.RawMessage) (any, error) {
	s.mu.Lock()
	c := s.clients[connectionID]
	if c == nil {
		s.mu.Unlock()
		return nil, AppError("settings_host_unavailable", "Open Multica Desktop with the same signed-in account to continue")
	}
	req := &hostRequest{id: newInstanceID(), clientID: connectionID, kind: kind, payload: payload, reply: make(chan hostReply, 1)}
	s.hostPending[req.id] = req
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.hostPending, req.id)
		s.mu.Unlock()
		_ = c.conn.Notify("hostRequestResolved", HostRequestResolvedNotification{ID: req.id})
	}()

	if err := c.conn.Notify("hostRequest", HostRequestNotification{ID: req.id, Kind: kind, Payload: payload}); err != nil {
		return nil, AppError("settings_host_unavailable", "The desktop that should handle this request disconnected")
	}
	timer := time.NewTimer(hostRequestTTL)
	defer timer.Stop()
	select {
	case reply := <-req.reply:
		if reply.err != nil {
			return nil, reply.err
		}
		return reply.result, nil
	case <-timer.C:
		return nil, AppError("settings_host_timeout", "The desktop did not respond; no change is confirmed")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Server) resolveHostRequest(c *client, id string, reply hostReply) error {
	s.mu.Lock()
	req := s.hostPending[id]
	if req != nil && req.clientID == c.id {
		delete(s.hostPending, id)
	}
	s.mu.Unlock()
	if req == nil || req.clientID != c.id {
		return AppError("host_request_resolved", "This request was already answered or has expired")
	}
	req.reply <- reply
	return nil
}

// --- HTTP files ---

func scopeFromQuery(r *http.Request) (Scope, bool) {
	q := r.URL.Query()
	scope := Scope{APIURL: q.Get("apiUrl"), UserID: q.Get("userId"), WorkspaceID: q.Get("workspaceId")}
	return scope, scope.APIURL != "" && scope.UserID != "" && scope.WorkspaceID != ""
}

func (s *Server) readFile(w http.ResponseWriter, r *http.Request, ref string) {
	scope, ok := scopeFromQuery(r)
	ref, err := url.PathUnescape(ref)
	if !ok || err != nil || ref == "" {
		http.Error(w, "invalid file request", http.StatusBadRequest)
		return
	}
	if err := s.checkProfileUser(scope.UserID); err != nil {
		writeAppError(w, http.StatusForbidden, err)
		return
	}
	conn, err := s.requireSidecar(r.Context())
	if err != nil {
		writeAppError(w, http.StatusServiceUnavailable, err)
		return
	}
	var file FileResolveResult
	if err := conn.Call(r.Context(), "file.resolve", FileResolveParams{Scope: scope, FileRef: ref}, &file); err != nil {
		writeAppError(w, http.StatusNotFound, err)
		return
	}
	f, err := os.Open(file.Path)
	if err != nil {
		http.Error(w, "file unavailable", http.StatusNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "file unavailable", http.StatusNotFound)
		return
	}
	if file.MimeType != "" {
		w.Header().Set("Content-Type", file.MimeType)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if file.Name != "" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": file.Name}))
	}
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	scope, ok := scopeFromQuery(r)
	name, err := url.PathUnescape(r.Header.Get("X-File-Name"))
	mimeType := r.Header.Get("Content-Type")
	if !ok || err != nil || name == "" || mimeType == "" {
		http.Error(w, "invalid upload", http.StatusBadRequest)
		return
	}
	if err := s.checkProfileUser(scope.UserID); err != nil {
		writeAppError(w, http.StatusForbidden, err)
		return
	}
	conn, err := s.requireSidecar(r.Context())
	if err != nil {
		writeAppError(w, http.StatusServiceUnavailable, err)
		return
	}
	dir := filepath.Join(s.cfg.DataDir, "uploads")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeAppError(w, http.StatusInternalServerError, err)
		return
	}
	tmp, err := os.CreateTemp(dir, "upload-*")
	if err != nil {
		writeAppError(w, http.StatusInternalServerError, err)
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(tmp.Name())
		}
	}()
	size, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, maxUploadBytes))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeAppError(w, http.StatusRequestEntityTooLarge, AppError("file_too_large", "File exceeds 25 MB"))
			return
		}
		writeAppError(w, http.StatusBadRequest, fmt.Errorf("read upload: %w", err))
		return
	}
	var out FileCommitResult
	if err := conn.Call(r.Context(), "file.commit", FileCommitParams{Scope: scope, TempPath: tmp.Name(), Name: name, MimeType: mimeType, Size: size}, &out); err != nil {
		writeAppError(w, http.StatusBadRequest, err)
		return
	}
	committed = true
	writeJSON(w, http.StatusOK, out)
}
