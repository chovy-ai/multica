package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type recordingWriter struct {
	mu         sync.Mutex
	lines      []string
	err        error
	afterWrite func(line string)
}

func (w *recordingWriter) Write(p []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	line := strings.TrimSuffix(string(p), "\n")
	w.mu.Lock()
	w.lines = append(w.lines, line)
	w.mu.Unlock()
	if w.afterWrite != nil {
		w.afterWrite(line)
	}
	return len(p), nil
}

func (w *recordingWriter) Lines() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.lines...)
}

func resolveLine(t *testing.T, c *Conn, line string) {
	t.Helper()
	frame, ok := ParseFrame([]byte(line))
	if !ok || frame.Kind != FrameResponse {
		t.Fatalf("ParseFrame(%s) = %+v, %v; want response", line, frame, ok)
	}
	c.Resolve(frame)
}

func TestRequestWritesFrameAndReturnsResult(t *testing.T) {
	t.Parallel()

	w := &recordingWriter{}
	c := NewConn(w)
	w.afterWrite = func(string) { resolveLine(t, c, `{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`) }

	result, err := c.Request(context.Background(), "thread/start", map[string]any{"cwd": "/tmp"})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if string(result) != `{"ok":true}` {
		t.Fatalf("result = %s", result)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(w.Lines()[0]), &sent); err != nil {
		t.Fatalf("sent frame is not JSON: %v", err)
	}
	if sent["jsonrpc"] != "2.0" || sent["id"] != float64(1) || sent["method"] != "thread/start" {
		t.Fatalf("sent frame = %v", sent)
	}
}

func TestRequestReturnsRPCError(t *testing.T) {
	t.Parallel()

	w := &recordingWriter{}
	c := NewConn(w)
	w.afterWrite = func(string) {
		resolveLine(t, c, `{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"bad request"}}`)
	}

	_, err := c.Request(context.Background(), "turn/start", nil)
	if err == nil || err.Error() != "turn/start: bad request (code=-32600)" {
		t.Fatalf("err = %v", err)
	}
}

func TestRequestAssignsIncreasingIDs(t *testing.T) {
	t.Parallel()

	w := &recordingWriter{}
	c := NewConn(w)
	var ids []int
	c.AfterWrite = func(id int, method string, params any) {
		ids = append(ids, id)
		c.Resolve(Frame{Kind: FrameResponse, ID: id, Result: json.RawMessage(`{}`)})
	}
	for range 3 {
		if _, err := c.Request(context.Background(), "m", nil); err != nil {
			t.Fatalf("Request: %v", err)
		}
	}
	if len(ids) != 3 || ids[0] != 1 || ids[1] != 2 || ids[2] != 3 {
		t.Fatalf("ids = %v, want [1 2 3]", ids)
	}
}

func TestRequestWriteErrorKeepsWritePrefix(t *testing.T) {
	t.Parallel()

	c := NewConn(&recordingWriter{err: errors.New("broken pipe")})
	_, err := c.Request(context.Background(), "initialize", nil)
	if err == nil || !strings.HasPrefix(err.Error(), "write initialize: ") {
		t.Fatalf("err = %v, want write prefix", err)
	}
}

func TestRequestFailsWithoutWritingAfterClose(t *testing.T) {
	t.Parallel()

	w := &recordingWriter{}
	c := NewConn(w)
	c.Close(nil)

	_, err := c.Request(context.Background(), "thread/start", nil)
	if !errors.Is(err, ErrProcessExited) {
		t.Fatalf("err = %v, want ErrProcessExited", err)
	}
	if len(w.Lines()) != 0 {
		t.Fatalf("wrote %d lines after close", len(w.Lines()))
	}
}

func TestRequestPrefersReadyResponseOverClose(t *testing.T) {
	t.Parallel()

	w := &recordingWriter{}
	c := NewConn(w)
	w.afterWrite = func(string) {
		resolveLine(t, c, `{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`)
		c.Close(nil)
	}

	result, err := c.Request(context.Background(), "thread/start", nil)
	if err != nil || string(result) != `{"ok":true}` {
		t.Fatalf("Request = %s, %v; want ready response", result, err)
	}
}

func TestRequestPrefersContextErrorOverClose(t *testing.T) {
	t.Parallel()

	w := &recordingWriter{}
	c := NewConn(w)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	closed := make(chan struct{})
	w.afterWrite = func(string) {
		cancel()
		// Close after the request observed the cancellation, as when the
		// process is torn down because its run was cancelled.
		go func() {
			time.Sleep(10 * time.Millisecond)
			c.Close(nil)
			close(closed)
		}()
	}

	_, err := c.Request(ctx, "thread/start", nil)
	<-closed
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestRequestMapsContextErrorWithHook(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("handshake timed out")
	c := NewConn(&recordingWriter{})
	c.ContextError = func(ctx context.Context) error {
		if errors.Is(context.Cause(ctx), sentinel) {
			return sentinel
		}
		return ctx.Err()
	}
	ctx, cancel := context.WithTimeoutCause(context.Background(), time.Millisecond, sentinel)
	defer cancel()

	_, err := c.Request(ctx, "initialize", nil)
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want mapped context error", err)
	}
}

func TestCloseFailsPendingAndIsIdempotent(t *testing.T) {
	t.Parallel()

	first := errors.New("first")
	c := NewConn(&recordingWriter{})
	done := make(chan error, 1)
	c.AfterWrite = func(int, string, any) {}
	go func() {
		_, err := c.Request(context.Background(), "m", nil)
		done <- err
	}()
	waitPending(t, c, 1)

	c.Close(first)
	c.Close(errors.New("second"))

	if err := <-done; !errors.Is(err, first) {
		t.Fatalf("pending err = %v, want first close error", err)
	}
	if !errors.Is(c.Err(), first) {
		t.Fatalf("Err = %v, want first close error", c.Err())
	}
	select {
	case <-c.Done():
	default:
		t.Fatal("Done not closed")
	}
}

func TestFailPendingKeepsConnOpen(t *testing.T) {
	t.Parallel()

	c := NewConn(&recordingWriter{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := c.Request(context.Background(), "m", nil)
			results <- err
		}()
	}
	waitPending(t, c, 2)

	c.FailPending(errors.New("reset"))
	for range 2 {
		if err := <-results; err == nil || err.Error() != "reset" {
			t.Fatalf("err = %v, want reset", err)
		}
	}
	if c.Err() != nil {
		t.Fatalf("Err = %v, want open conn", c.Err())
	}
}

func TestResolveIgnoresUnknownID(t *testing.T) {
	t.Parallel()

	c := NewConn(&recordingWriter{})
	c.Resolve(Frame{Kind: FrameResponse, ID: 42, Result: json.RawMessage(`{}`)})
}

func TestReplyFrames(t *testing.T) {
	t.Parallel()

	w := &recordingWriter{}
	c := NewConn(w)
	c.Notify("initialized")
	c.Respond(7, map[string]any{"decision": "accept"})
	c.RespondError(8, -32601, "unsupported")

	want := []string{
		`{"jsonrpc":"2.0","method":"initialized"}`,
		`{"id":7,"jsonrpc":"2.0","result":{"decision":"accept"}}`,
		`{"error":{"code":-32601,"message":"unsupported"},"id":8,"jsonrpc":"2.0"}`,
	}
	got := w.Lines()
	if len(got) != len(want) {
		t.Fatalf("lines = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d = %s, want %s", i, got[i], want[i])
		}
	}
}

func waitPending(t *testing.T, c *Conn, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		count := len(c.pending)
		c.mu.Unlock()
		if count == n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("pending requests did not reach %d", n)
}
