package service

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

const choiceQuestion = `{"request_id":"q1","questions":[{"id":"go","question":"继续吗？","options":[{"label":"是"},{"label":"否"}],"allowFreeText":false}]}`

type questionFixture struct {
	*serviceFixture
	tool contextmcp.Tool
}

func newQuestionFixture(t *testing.T) *questionFixture {
	t.Helper()
	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	f.create(t, "conv-1", "claude")
	if _, err := f.svc.Send(context.Background(), SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	conv, _ := f.svc.Store().Conversation(context.Background(), "conv-1")
	tool := f.svc.questionToolFor(conv, func() map[string]any { return map[string]any{"turn_id": "turn-r1"} })
	return &questionFixture{serviceFixture: f, tool: tool}
}

type askResult struct {
	value any
	err   error
}

func (q *questionFixture) ask(ctx context.Context, raw string) chan askResult {
	out := make(chan askResult, 1)
	go func() {
		r, err := q.tool.Call(ctx, json.RawMessage(raw))
		out <- askResult{r.Value, err}
	}()
	return out
}

func (q *questionFixture) waitPending(t *testing.T, n int64) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		conv, _ := q.svc.Store().Conversation(context.Background(), "conv-1")
		if conv.PendingInteractions == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("pending interactions = %d, want %d", conv.PendingInteractions, n)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func receive(t *testing.T, ch chan askResult) askResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(3 * time.Second):
		t.Fatal("ask_user_question did not return")
		return askResult{}
	}
}

func TestQuestionWaitsForTheFirstAnswer(t *testing.T) {
	t.Parallel()

	q := newQuestionFixture(t)
	ctx := context.Background()
	first := q.ask(ctx, choiceQuestion)
	q.waitPending(t, 1)
	// A retry of the same request waits for the same answer.
	retry := q.ask(ctx, choiceQuestion)
	id := questionInteractionID("turn-r1", "q1")

	if err := q.svc.Answer(ctx, q.scopeID, "conv-1", id, json.RawMessage(`{"go":"也许"}`), "desktop"); err == nil || !strings.Contains(err.Error(), "offered") {
		t.Fatalf("answer outside the options = %v", err)
	}
	if err := q.svc.Answer(ctx, q.scopeID, "conv-1", id, json.RawMessage(`{"go":"是"}`), "desktop"); err != nil {
		t.Fatal(err)
	}
	for _, ch := range []chan askResult{first, retry} {
		r := receive(t, ch)
		if r.err != nil || r.value.(map[string]any)["answersByQuestionId"].(map[string]any)["go"] != "是" {
			t.Fatalf("ask = %+v", r)
		}
	}
	q.waitPending(t, 0)
	// The same answer again is accepted; a different one is rejected.
	if err := q.svc.Answer(ctx, q.scopeID, "conv-1", id, json.RawMessage(`{"go":"是"}`), "other-window"); err != nil {
		t.Fatalf("repeated answer = %v", err)
	}
	if err := q.svc.Answer(ctx, q.scopeID, "conv-1", id, json.RawMessage(`{"go":"否"}`), "other-window"); !errors.Is(err, ErrInteractionAnswered) {
		t.Fatalf("different answer = %v", err)
	}
	// Asking the answered request again returns the stored answer.
	again := receive(t, q.ask(ctx, choiceQuestion))
	if again.err != nil || again.value.(map[string]any)["answersByQuestionId"].(map[string]any)["go"] != "是" {
		t.Fatalf("ask after answer = %+v", again)
	}

	events, _ := q.svc.Store().TurnEvents(ctx, "conv-1", "turn-r1")
	var types []string
	for _, e := range events {
		if strings.HasPrefix(e.Type, "interaction.") {
			types = append(types, e.Type)
		}
	}
	if strings.Join(types, ",") != "interaction.requested,interaction.resolved" {
		t.Fatalf("interaction events = %v", types)
	}
}

func TestQuestionRequestIDsAreBoundToTheirQuestions(t *testing.T) {
	t.Parallel()

	q := newQuestionFixture(t)
	ctx := context.Background()
	q.ask(ctx, choiceQuestion)
	q.waitPending(t, 1)
	other := receive(t, q.ask(ctx, `{"request_id":"q1","questions":[{"id":"other","question":"different?"}]}`))
	if other.err == nil || !strings.Contains(other.err.Error(), "different question") {
		t.Fatalf("reused request id = %+v", other)
	}
	bad := receive(t, q.ask(ctx, `{"request_id":"q2","questions":[{"id":"x","question":"fixed","allowFreeText":false}]}`))
	if bad.err == nil {
		t.Fatal("fixed-choice question without options accepted")
	}
}

func TestQuestionsCloseWithTheirTurnOrExecution(t *testing.T) {
	t.Parallel()

	q := newQuestionFixture(t)
	ctx := context.Background()
	waiting := q.ask(ctx, choiceQuestion)
	q.waitPending(t, 1)
	q.svc.turnEnded("conv-1", "turn-r1")
	if r := receive(t, waiting); r.err == nil || !strings.Contains(r.err.Error(), "ended") {
		t.Fatalf("ask after turn end = %+v", r)
	}
	q.waitPending(t, 0)
	id := questionInteractionID("turn-r1", "q1")
	if err := q.svc.Answer(ctx, q.scopeID, "conv-1", id, json.RawMessage(`{"go":"是"}`), "d"); !errors.Is(err, ErrInteractionClosed) {
		t.Fatalf("answer to a closed question = %v", err)
	}
	if r := receive(t, q.ask(ctx, choiceQuestion)); r.err == nil || !strings.Contains(r.err.Error(), "no longer active") {
		t.Fatalf("reusing a closed request id = %+v", r)
	}

	stop, cancel := context.WithCancel(ctx)
	ended := q.ask(stop, `{"request_id":"q2","questions":[{"id":"why","question":"why?"}]}`)
	q.waitPending(t, 1)
	cancel()
	if r := receive(t, ended); r.err == nil {
		t.Fatal("ask survived the end of its execution")
	}
	q.waitPending(t, 0)
}

func TestRestartCancelsQuestionsOfInterruptedTurns(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "c.sqlite")
	ctx := context.Background()
	st, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	scopeID, _ := st.EnsureScope(ctx, store.Scope{APIOrigin: "o", UserID: "u", WorkspaceID: "w"})
	_, _ = st.CreateConversation(ctx, store.NewConversation{ID: "conv-1", ScopeID: scopeID, Provider: "claude", CreatedAt: time.Now()})
	w := st.NewWriter(store.WriterOptions{})
	_, err = w.Submit(ctx, store.Batch{ConversationID: "conv-1", StartTurn: &store.NewTurn{ID: "turn-1", StartedAt: time.Now()},
		Interactions: []store.NewInteraction{{ID: "question:turn-1:q1", TurnID: "turn-1", Kind: "question", Request: json.RawMessage(choiceQuestion), CreatedAt: time.Now()}}})
	if err != nil {
		t.Fatal(err)
	}
	w.Close()
	_ = st.Close()

	f := newServiceFixture(t, path)
	row, err := f.svc.Store().Interaction(ctx, "question:turn-1:q1")
	if err != nil || row.Status != "cancelled" {
		t.Fatalf("interaction after restart = %+v, %v", row, err)
	}
	if conv, _ := f.svc.Store().Conversation(ctx, "conv-1"); conv.PendingInteractions != 0 {
		t.Fatalf("pending count = %d", conv.PendingInteractions)
	}
}

func TestQuestionAnswersValidation(t *testing.T) {
	t.Parallel()

	qs, err := parseUserQuestions(json.RawMessage(`{"request_id":"r","questions":[{"id":"a","question":"pick","options":[{"label":"x"},{"label":"y"}],"multiSelect":true},{"id":"b","question":"free"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !qs.Questions[1].AllowFreeText || qs.Questions[1].MultiSelect {
		t.Fatalf("defaults = %+v", qs.Questions[1])
	}
	answers, err := questionAnswers(qs, json.RawMessage(`{"a":["x","x","y"],"b":" anything "}`))
	if err != nil || len(answers["a"].([]string)) != 2 || answers["b"] != "anything" {
		t.Fatalf("answers = %v, %v", answers, err)
	}
	if _, err := questionAnswers(qs, json.RawMessage(`{"a":["x"]}`)); err == nil {
		t.Fatal("missing answer accepted")
	}
	for _, bad := range []string{
		`{"request_id":"r","questions":[]}`,
		`{"request_id":"bad id","questions":[{"id":"a","question":"q"}]}`,
		`{"request_id":"r","questions":[{"id":"a","question":"q"},{"id":"a","question":"q"}]}`,
		`{"request_id":"r","questions":[{"id":"a","question":"q","options":[{"label":"x"},{"label":"x"}]}]}`,
	} {
		if _, err := parseUserQuestions(json.RawMessage(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}
