// Package localhost hosts the desktop local conversation service: it locates
// and supervises the Node sidecar that runs conversations, and exposes the
// loopback Local API (HTTP + WebSocket) Desktop uses to reach it.
package localhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

// Transport moves whole JSON-RPC messages. Sidecar stdio frames them as lines;
// the desktop WebSocket frames them as text messages.
type Transport interface {
	ReadMessage() ([]byte, error)
	WriteMessage([]byte) error
	Close() error
}

// RPCError is a JSON-RPC error object. Code carries the protocol's numeric
// code; Data carries the application error ("account_mismatch", ...).
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return e.Message }

const (
	rpcInvalidRequest = -32600
	rpcMethodNotFound = -32601
	rpcInternal       = -32603
	// rpcApplication marks errors whose Data carries an application code.
	rpcApplication = -32000
)

// AppError builds an application error with a stable machine-readable code.
func AppError(code, message string) *RPCError {
	return &RPCError{Code: rpcApplication, Message: message, Data: map[string]string{"code": code}}
}

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *uint64         `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// Handler serves requests (id set) and notifications (id nil) from the peer.
// A notification's return value is discarded.
type Handler func(ctx context.Context, method string, params json.RawMessage) (any, error)

// Conn is a bidirectional JSON-RPC 2.0 peer: both sides may send requests.
type Conn struct {
	t       Transport
	handler Handler
	writeMu sync.Mutex
	nextID  atomic.Uint64
	mu      sync.Mutex
	pending map[uint64]chan message
	closed  chan struct{}
	err     error
	once    sync.Once
	// notes preserves notification order (events carry sequence numbers)
	// without letting a slow handler stall replies to this side's calls.
	notes chan message
}

// NewConn starts reading from t. Incoming requests run concurrently;
// notifications are handled one at a time in arrival order.
func NewConn(t Transport, handler Handler) *Conn {
	c := &Conn{t: t, handler: handler, pending: map[uint64]chan message{}, closed: make(chan struct{}), notes: make(chan message, 1024)}
	go c.readLoop()
	go c.noteLoop()
	return c
}

func (c *Conn) noteLoop() {
	for {
		select {
		case m := <-c.notes:
			c.serve(m)
		case <-c.closed:
			return
		}
	}
}

// Done is closed once the transport fails or Close is called.
func (c *Conn) Done() <-chan struct{} { return c.closed }

// Err reports why the connection ended.
func (c *Conn) Err() error {
	<-c.closed
	return c.err
}

func (c *Conn) Close() error {
	c.shutdown(errors.New("connection closed"))
	return nil
}

func (c *Conn) shutdown(err error) {
	c.once.Do(func() {
		c.mu.Lock()
		c.err = err
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
		c.mu.Unlock()
		close(c.closed)
		_ = c.t.Close()
	})
}

func (c *Conn) readLoop() {
	for {
		data, err := c.t.ReadMessage()
		if err != nil {
			c.shutdown(err)
			return
		}
		var m message
		if json.Unmarshal(data, &m) != nil || m.JSONRPC != "2.0" {
			continue
		}
		if m.Method == "" {
			if m.ID == nil {
				continue
			}
			c.mu.Lock()
			ch := c.pending[*m.ID]
			delete(c.pending, *m.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- m
			}
			continue
		}
		if m.ID == nil {
			select {
			case c.notes <- m:
			case <-c.closed:
				return
			}
			continue
		}
		go c.serve(m)
	}
}

func (c *Conn) serve(m message) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-c.closed:
			cancel()
		case <-ctx.Done():
		}
	}()
	var result any
	var err error
	if c.handler == nil {
		err = &RPCError{Code: rpcMethodNotFound, Message: "method not found: " + m.Method}
	} else {
		result, err = c.handler(ctx, m.Method, m.Params)
	}
	if m.ID == nil {
		return
	}
	reply := message{JSONRPC: "2.0", ID: m.ID}
	if err != nil {
		var rpcErr *RPCError
		if !errors.As(err, &rpcErr) {
			rpcErr = &RPCError{Code: rpcInternal, Message: err.Error()}
		}
		reply.Error = rpcErr
	} else {
		raw, merr := json.Marshal(result)
		if merr != nil {
			reply.Error = &RPCError{Code: rpcInternal, Message: merr.Error()}
		} else {
			reply.Result = raw
		}
	}
	_ = c.write(reply)
}

func (c *Conn) write(m message) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	select {
	case <-c.closed:
		return c.err
	default:
	}
	if err := c.t.WriteMessage(data); err != nil {
		c.shutdown(err)
		return err
	}
	return nil
}

// Notify sends a notification without waiting for delivery confirmation.
func (c *Conn) Notify(method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(message{JSONRPC: "2.0", Method: method, Params: raw})
}

// Call sends a request and decodes the result into out (which may be nil).
func (c *Conn) Call(ctx context.Context, method string, params any, out any) error {
	raw, err := c.CallRaw(ctx, method, params)
	if err != nil || out == nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// CallRaw sends a request and returns the undecoded result.
func (c *Conn) CallRaw(ctx context.Context, method string, params any) (json.RawMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	id := c.nextID.Add(1)
	ch := make(chan message, 1)
	c.mu.Lock()
	select {
	case <-c.closed:
		c.mu.Unlock()
		return nil, fmt.Errorf("call %s: %w", method, c.err)
	default:
	}
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.write(message{JSONRPC: "2.0", ID: &id, Method: method, Params: raw}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("call %s: %w", method, err)
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("call %s: %w", method, c.err)
		}
		if m.Error != nil {
			return nil, m.Error
		}
		return m.Result, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}
