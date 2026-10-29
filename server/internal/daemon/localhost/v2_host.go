package localhost

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/service"
)

// hostTimeout bounds how long an execution waits for Desktop; questions
// to the user use ask_user_question, not host requests.
const hostTimeout = 10 * time.Minute

// hosts routes daemon requests to the Desktop connections of a scope.
type hosts struct {
	mu      sync.Mutex
	byScope map[int64][]*wsConn
	pending map[string]chan v2HostReply
}

type v2HostReply struct {
	result json.RawMessage
	err    error
}

// attach makes c the scope's preferred Desktop and returns its detach.
func (h *hosts) attach(scopeID int64, c *wsConn) func() {
	h.mu.Lock()
	h.byScope[scopeID] = append(h.byScope[scopeID], c)
	h.mu.Unlock()
	return func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		conns := h.byScope[scopeID]
		for i, x := range conns {
			if x == c {
				h.byScope[scopeID] = append(conns[:i], conns[i+1:]...)
				break
			}
		}
		for id, ch := range c.hostPending {
			delete(h.pending, id)
			ch <- v2HostReply{err: service.ErrHostUnavailable}
		}
	}
}

// touch prefers c, the connection the user acted through last.
func (h *hosts) touch(scopeID int64, c *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	conns := h.byScope[scopeID]
	for i, x := range conns {
		if x == c && i != len(conns)-1 {
			h.byScope[scopeID] = append(append(conns[:i:i], conns[i+1:]...), c)
			return
		}
	}
}

// request sends kind to the scope's preferred Desktop and waits for its
// reply.
func (h *hosts) request(ctx context.Context, scopeID int64, kind string, payload any) (json.RawMessage, error) {
	h.mu.Lock()
	conns := h.byScope[scopeID]
	if len(conns) == 0 {
		h.mu.Unlock()
		return nil, service.ErrHostUnavailable
	}
	c := conns[len(conns)-1]
	id := "host-" + newRequestID()
	ch := make(chan v2HostReply, 1)
	h.pending[id] = ch
	c.hostPending[id] = ch
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, id)
		delete(c.hostPending, id)
		h.mu.Unlock()
	}()
	if err := c.send(map[string]any{"version": V2Version, "type": "host.request", "request_id": id, "kind": kind, "payload": payload}); err != nil {
		return nil, service.ErrHostUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, hostTimeout)
	defer cancel()
	select {
	case r := <-ch:
		return r.result, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// reply delivers Desktop's answer to the pending request it names.
func (h *hosts) reply(c *wsConn, msg wsClientMessage) {
	h.mu.Lock()
	ch := c.hostPending[msg.RequestID]
	h.mu.Unlock()
	if ch == nil {
		return
	}
	r := v2HostReply{result: msg.Result}
	if msg.Error != nil {
		r.err = &service.HostError{Kind: msg.Error.Kind, Message: msg.Error.Message}
	}
	select {
	case ch <- r:
	default:
	}
}

func newRequestID() string {
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
