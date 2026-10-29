package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

type recordingCommitter struct {
	mu      sync.Mutex
	batches []store.Batch
	block   chan struct{}
	fail    error
}

func (c *recordingCommitter) Submit(_ context.Context, b store.Batch) (store.Committed, error) {
	if c.block != nil {
		<-c.block
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail != nil {
		return store.Committed{}, c.fail
	}
	c.batches = append(c.batches, b)
	return store.Committed{}, nil
}

func (c *recordingCommitter) snapshot() []store.Batch {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]store.Batch(nil), c.batches...)
}

// manualTimers runs scheduled flushes only when the test fires them.
type manualTimers struct {
	mu  sync.Mutex
	fns []func()
}

func (m *manualTimers) after(_ time.Duration, f func()) func() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	i := len(m.fns)
	m.fns = append(m.fns, f)
	return func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		active := m.fns[i] != nil
		m.fns[i] = nil
		return active
	}
}

func (m *manualTimers) fire() {
	m.mu.Lock()
	fns := m.fns
	m.fns = make([]func(), len(fns))
	m.mu.Unlock()
	for _, f := range fns {
		if f != nil {
			f()
		}
	}
}

func part(conv string, texts ...string) store.Batch {
	b := store.Batch{ConversationID: conv}
	for _, t := range texts {
		payload, _ := json.Marshal(map[string]string{"text": t})
		b.Events = append(b.Events, store.NewEvent{Type: "item.delta", ItemID: "it", Payload: payload})
	}
	return b
}

func eventTexts(b store.Batch) string {
	var out []string
	for _, e := range b.Events {
		var p map[string]string
		_ = json.Unmarshal(e.Payload, &p)
		out = append(out, p["text"])
	}
	return strings.Join(out, ",")
}

func waitBatches(t *testing.T, c *recordingCommitter, n int) []store.Batch {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got := c.snapshot(); len(got) >= n {
			return got
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("got %d batches, want %d", len(c.snapshot()), n)
	return nil
}

func TestBatcherFlushesAfterDelayFromFirstEvent(t *testing.T) {
	t.Parallel()

	c, timers := &recordingCommitter{}, &manualTimers{}
	b := NewBatcher(c, BatcherOptions{AfterFunc: timers.after})
	for _, text := range []string{"a", "b", "c"} {
		if err := b.Append(part("conv-1", text), false); err != nil {
			t.Fatal(err)
		}
	}
	if got := c.snapshot(); len(got) != 0 {
		t.Fatalf("flushed before the delay: %d batches", len(got))
	}
	// One timer for the batch: later events do not reset the deadline.
	if len(timers.fns) != 1 {
		t.Fatalf("timers scheduled = %d, want 1", len(timers.fns))
	}
	timers.fire()
	if got := waitBatches(t, c, 1); eventTexts(got[0]) != "a,b,c" {
		t.Fatalf("batch = %s", eventTexts(got[0]))
	}
	b.Close()
}

func TestBatcherFlushesAtSizeAndOnCriticalEvents(t *testing.T) {
	t.Parallel()

	c, timers := &recordingCommitter{}, &manualTimers{}
	b := NewBatcher(c, BatcherOptions{AfterFunc: timers.after, MaxBatchBytes: 200})
	_ = b.Append(part("conv-1", strings.Repeat("x", 300)), false)
	waitBatches(t, c, 1)

	_ = b.Append(part("conv-1", "delta"), false)
	_ = b.Append(part("conv-1", "turn.completed"), true)
	got := waitBatches(t, c, 2)
	// The critical event commits together with what came before it.
	if eventTexts(got[1]) != "delta,turn.completed" {
		t.Fatalf("critical batch = %s", eventTexts(got[1]))
	}
	b.Close()
}

func TestBatcherKeepsOrderWhileACommitIsInFlight(t *testing.T) {
	t.Parallel()

	c := &recordingCommitter{block: make(chan struct{})}
	timers := &manualTimers{}
	b := NewBatcher(c, BatcherOptions{AfterFunc: timers.after})
	_ = b.Append(part("conv-1", "1"), true)
	// Appends while the first commit blocks never wait for storage.
	done := make(chan struct{})
	go func() {
		_ = b.Append(part("conv-1", "2"), false)
		_ = b.Append(part("conv-1", "3"), true)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Append blocked on an in-flight commit")
	}
	close(c.block)
	got := waitBatches(t, c, 2)
	if eventTexts(got[0]) != "1" || eventTexts(got[1]) != "2,3" {
		t.Fatalf("batches = %s | %s", eventTexts(got[0]), eventTexts(got[1]))
	}
	b.Close()
}

func TestBatcherSplitsBatchesAtASecondTurnBoundary(t *testing.T) {
	t.Parallel()

	c, timers := &recordingCommitter{}, &manualTimers{}
	b := NewBatcher(c, BatcherOptions{AfterFunc: timers.after})
	_ = b.Append(store.Batch{ConversationID: "conv-1", StartTurn: &store.NewTurn{ID: "t1"}}, false)
	_ = b.Append(store.Batch{ConversationID: "conv-1", CompleteTurn: &store.TurnCompletion{TurnID: "t1"}}, false)
	_ = b.Append(store.Batch{ConversationID: "conv-1", StartTurn: &store.NewTurn{ID: "t2"}}, false)
	b.Close()
	got := c.snapshot()
	if len(got) != 2 || got[0].StartTurn.ID != "t1" || got[0].CompleteTurn == nil || got[1].StartTurn.ID != "t2" {
		t.Fatalf("batches = %+v", got)
	}
}

func TestBatcherRejectsAppendsBeyondThePendingBudget(t *testing.T) {
	t.Parallel()

	c := &recordingCommitter{block: make(chan struct{})}
	timers := &manualTimers{}
	b := NewBatcher(c, BatcherOptions{AfterFunc: timers.after, MaxPendingBytes: 500})
	if err := b.Append(part("conv-1", strings.Repeat("x", 300)), true); err != nil {
		t.Fatal(err)
	}
	if err := b.Append(part("conv-2", strings.Repeat("y", 300)), false); !errors.Is(err, ErrStorageBacklog) {
		t.Fatalf("Append over budget = %v, want ErrStorageBacklog", err)
	}
	// Critical parts such as turn completion are never rejected.
	if err := b.Append(part("conv-2", "turn.completed"), true); err != nil {
		t.Fatalf("critical Append over budget = %v", err)
	}
	close(c.block)
	waitBatches(t, c, 2)
	// The budget frees up once the commits finish.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if err := b.Append(part("conv-2", strings.Repeat("y", 300)), false); err == nil {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("budget never freed: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
	b.Close()
}

func TestBatcherReportsCommitFailures(t *testing.T) {
	t.Parallel()

	c := &recordingCommitter{fail: errors.New("disk full")}
	failed := make(chan error, 1)
	b := NewBatcher(c, BatcherOptions{Failed: func(_ string, err error) { failed <- err }})
	_ = b.Append(part("conv-1", "a"), true)
	if err := <-failed; err == nil || err.Error() != "disk full" {
		t.Fatalf("failure = %v", err)
	}
	b.Close()
}

func TestBatcherMergesSummaryPatches(t *testing.T) {
	t.Parallel()

	c, timers := &recordingCommitter{}, &manualTimers{}
	b := NewBatcher(c, BatcherOptions{AfterFunc: timers.after})
	running, title, preview := "running", "排查", "测试"
	_ = b.Append(store.Batch{ConversationID: "conv-1", Summary: &store.SummaryPatch{Status: &running, Title: &title}}, false)
	_ = b.Append(store.Batch{ConversationID: "conv-1", Summary: &store.SummaryPatch{LastMessagePreview: &preview}}, false)
	b.Close()
	got := c.snapshot()
	if len(got) != 1 || *got[0].Summary.Status != "running" || *got[0].Summary.Title != "排查" || *got[0].Summary.LastMessagePreview != "测试" {
		t.Fatalf("summary = %+v", got[0].Summary)
	}
}

func TestBatcherCloseFlushesAndRejectsLaterAppends(t *testing.T) {
	t.Parallel()

	c, timers := &recordingCommitter{}, &manualTimers{}
	b := NewBatcher(c, BatcherOptions{AfterFunc: timers.after})
	_ = b.Append(part("conv-1", "a"), false)
	_ = b.Append(part("conv-2", "b"), false)
	b.Close()
	if got := c.snapshot(); len(got) != 2 {
		t.Fatalf("Close flushed %d batches, want 2", len(got))
	}
	if err := b.Append(part("conv-1", "c"), false); !errors.Is(err, store.ErrWriterClosed) {
		t.Fatalf("Append after Close = %v", err)
	}
}
