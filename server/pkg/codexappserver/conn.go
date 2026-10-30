// Package codexappserver implements the JSON-RPC transport spoken by
// `codex app-server --listen stdio://`: request correlation, notifications,
// replies to server requests, and failure of pending calls when the process
// exits. Turn semantics stay with the callers.
package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// ErrProcessExited is the default error for calls that can no longer be
// answered because the app-server process is gone.
var ErrProcessExited = errors.New("codex process exited")

// Conn correlates JSON-RPC requests written to the app-server's stdin with the
// responses read from its stdout. It is safe for concurrent use.
type Conn struct {
	w io.Writer

	// ContextError maps a request context that ended into the error returned
	// to the caller. It defaults to ctx.Err().
	ContextError func(ctx context.Context) error
	// AfterWrite, when set, runs after a request frame was written and before
	// its response is awaited.
	AfterWrite func(id int, method string, params any)

	mu      sync.Mutex
	nextID  int
	pending map[int]*pendingCall
	done    chan struct{}
	err     error
}

type pendingCall struct {
	ch     chan callResult
	method string
}

type callResult struct {
	result json.RawMessage
	err    error
}

// NewConn returns a Conn that writes frames to w.
func NewConn(w io.Writer) *Conn {
	return &Conn{w: w, pending: make(map[int]*pendingCall), done: make(chan struct{})}
}

// Request sends one request and waits for its response, the end of ctx, or the
// process exit. A response that is already available wins over a concurrent
// process exit; a cancelled ctx wins over the exit error.
func (c *Conn) Request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return nil, err
	}
	c.nextID++
	id := c.nextID
	call := &pendingCall{ch: make(chan callResult, 1), method: method}
	c.pending[id] = call
	c.mu.Unlock()

	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		c.forget(id)
		return nil, err
	}
	if _, err := c.w.Write(append(data, '\n')); err != nil {
		c.forget(id)
		return nil, fmt.Errorf("write %s: %w", method, err)
	}
	if c.AfterWrite != nil {
		c.AfterWrite(id, method, params)
	}

	select {
	case res := <-call.ch:
		return res.result, res.err
	case <-c.done:
		select {
		case res := <-call.ch:
			return res.result, res.err
		default:
		}
		c.forget(id)
		if ctx.Err() != nil {
			return nil, c.contextError(ctx)
		}
		return nil, c.Err()
	case <-ctx.Done():
		c.forget(id)
		return nil, c.contextError(ctx)
	}
}

// Notify sends a notification without params.
func (c *Conn) Notify(method string) {
	c.write(map[string]any{"jsonrpc": "2.0", "method": method})
}

// Respond answers a server request.
func (c *Conn) Respond(id int, result any) {
	c.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// RespondError rejects a server request.
func (c *Conn) RespondError(id int, code int, message string) {
	c.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
}

// Resolve delivers a response frame to the request waiting for it. Frames for
// unknown or already settled ids are ignored.
func (c *Conn) Resolve(frame Frame) {
	c.mu.Lock()
	call, ok := c.pending[frame.ID]
	if ok {
		delete(c.pending, frame.ID)
	}
	c.mu.Unlock()
	if !ok {
		return
	}

	if frame.Error != nil {
		var rpcErr struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(frame.Error, &rpcErr)
		call.ch <- callResult{err: fmt.Errorf("%s: %s (code=%d)", call.method, rpcErr.Message, rpcErr.Code)}
		return
	}
	call.ch <- callResult{result: frame.Result}
}

// FailPending fails every waiting request with err without marking the
// connection closed.
func (c *Conn) FailPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, call := range c.pending {
		call.ch <- callResult{err: err}
		delete(c.pending, id)
	}
}

// Close marks the process as exited. Waiting and later requests fail with err,
// or ErrProcessExited when err is nil. Only the first call takes effect.
func (c *Conn) Close(err error) {
	if err == nil {
		err = ErrProcessExited
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err == nil {
		c.err = err
		close(c.done)
	}
	for id, call := range c.pending {
		call.ch <- callResult{err: err}
		delete(c.pending, id)
	}
}

// Done is closed when Close is first called.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err returns the error passed to Close, or nil while the process is running.
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Conn) forget(id int) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *Conn) contextError(ctx context.Context) error {
	if c.ContextError != nil {
		return c.ContextError(ctx)
	}
	return ctx.Err()
}

func (c *Conn) write(msg map[string]any) {
	data, _ := json.Marshal(msg)
	_, _ = c.w.Write(append(data, '\n'))
}
