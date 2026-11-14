package service

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/provider"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

func TestClaudeMixedUserMessageKeepsPreviousToolResultAfterReload(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(fmt.Sprintf("failed=%v", failed), func(t *testing.T) {
			ctx := context.Background()
			assistant := json.RawMessage(`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"before"},{"type":"tool_use","id":"call","name":"Bash","input":{"command":"fixture"}}]}}`)
			mixed := json.RawMessage(fmt.Sprintf(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call","content":"changed notes","is_error":%t},{"type":"text","text":"Now check the result"}]},"tool_use_result":{"bashEditDiff":{"files":[],"changedFiles":["notes.md"],"moreFiles":1}}}`, failed))
			// Live and imported results must have identical output, status and evidence.
			live := claude.NewNormalizer(contextmcp.Name)
			var expected provider.Transcript
			expected.Add(live.Accept(assistant)...)
			expected.Add(live.Accept(mixed)...)
			expected.Add(live.Close("cancelled")...)
			adapter := &fakeAdapter{reply: func(typ string) (json.RawMessage, error) {
				if typ == "get_session_info" {
					return json.RawMessage(`{"cwd":"/fixture","createdAt":1793000000000}`), nil
				}
				return json.RawMessage(fmt.Sprintf(`[{"type":"user","message":{"content":"edit notes"}},%s,%s,{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"checked"}]}}]`, assistant, mixed)), nil
			}}
			session, err := (&claudeHistory{adapter: adapter}).read(ctx, "source")
			if err != nil {
				t.Fatal(err)
			}
			if len(session.turns) != 2 || session.turns[0].user != "edit notes" || session.turns[1].user != "Now check the result" {
				t.Fatalf("mixed message must finish the old turn and start the next: %+v", session.turns)
			}
			if !reflect.DeepEqual(session.turns[0].events, expected.Events()) {
				t.Fatalf("history = %+v; live = %+v", session.turns[0].events, expected.Events())
			}
			path := filepath.Join(t.TempDir(), "history.sqlite")
			db, err := store.Open(ctx, path)
			if err != nil {
				t.Fatal(err)
			}
			scope, err := db.EnsureScope(ctx, store.Scope{APIOrigin: "o", UserID: "u", WorkspaceID: "w"})
			if err != nil {
				t.Fatal(err)
			}
			_, err = db.ImportConversation(ctx, store.NewConversation{ID: "import", ScopeID: scope, Provider: "claude", Cwd: "/fixture", CreatedAt: time.Now()}, importBatches("import", session.turns))
			if err != nil {
				t.Fatal(err)
			}
			if err = db.Close(); err != nil {
				t.Fatal(err)
			}
			db, err = store.Open(ctx, path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			events, err := db.EventsAfter(ctx, "import", 0, 1000, 100)
			if err != nil {
				t.Fatal(err)
			}
			var order []string
			for _, event := range events {
				var payload map[string]any
				if err := json.Unmarshal([]byte(event.Payload), &payload); err != nil {
					t.Fatal(err)
				}
				if event.Type == "user.message" {
					order = append(order, fmt.Sprint(payload["content"]))
				}
				if event.Type != "item.completed" {
					continue
				}
				if payload["source_item_id"] == "call" {
					order = append(order, "call")
					if event.TurnID.String != "import~import-00001" {
						t.Fatalf("tool result moved to the new turn: %+v", event)
					}
					delete(payload, "source_item_id")
					if !reflect.DeepEqual(payload, expected.Events()[1].Payload) {
						t.Fatalf("reloaded tool result = %+v; live = %+v", payload, expected.Events()[1].Payload)
					}
				} else if payload["kind"] == "assistant_text" {
					order = append(order, fmt.Sprint(payload["text"]))
				}
			}
			if !reflect.DeepEqual(order, []string{"edit notes", "before", "call", "Now check the result", "checked"}) {
				t.Fatalf("reloaded order = %v", order)
			}
		})
	}
}

func TestHistoryAdaptersKeepOrderResultsAndNativeEvidenceAfterReload(t *testing.T) {
	ctx := context.Background()
	for _, name := range []string{"claude", "codex"} {
		t.Run(name, func(t *testing.T) {
			var session nativeSession
			var err error
			if name == "claude" {
				adapter := &fakeAdapter{reply: func(typ string) (json.RawMessage, error) {
					if typ == "get_session_info" {
						return json.RawMessage(`{"cwd":"/fixture","createdAt":1793000000000}`), nil
					}
					return json.RawMessage(`[
     {"type":"user","message":{"content":"fixture"}},
     {"type":"system","subtype":"compact_boundary","uuid":"compact"},
     {"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"before"},{"type":"tool_use","id":"native-call","name":"Bash","input":{"command":"fixture"}}]}},
     {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"native-call","content":"partial failure","is_error":true}]},"tool_use_result":{"bashEditDiff":{"files":[],"changedFiles":["notes.md"],"moreFiles":1}}},
     {"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"after"}]}}
    ]`), nil
				}}
				session, err = (&claudeHistory{adapter: adapter}).read(ctx, "source")
			} else {
				server := &fakeCodex{params: map[string]map[string]any{}}
				server.reply = func(method string, _ map[string]any) (json.RawMessage, bool) {
					if method == "thread/read" {
						return json.RawMessage(`{"thread":{"id":"source","cwd":"/fixture","createdAt":1793000000}}`), true
					}
					return json.RawMessage(`{"data":[{"status":"completed","itemsView":"full","items":[
     {"type":"userMessage","content":[{"type":"text","text":"fixture"}]},
     {"type":"agentMessage","id":"m1","text":"before"},
     {"type":"commandExecution","id":"native-call","status":"failed","command":"fixture","cwd":"/fixture","durationMs":42,"exitCode":1,"aggregatedOutput":"partial failure"},
     {"type":"fileChange","id":"native-file","status":"completed","changes":[{"path":"notes.md","kind":{"type":"update"},"diff":"@@ -1 +1 @@\n-old\n+new\n"}]},
     {"type":"dynamicToolCall","id":"dynamic","status":"completed","tool":"fixture","contentItems":[{"type":"text","text":"dynamic output"}]},
     {"type":"agentMessage","id":"m2","text":"after"}]}],"nextCursor":null}`), true
				}
				session, err = (&codexHistory{server: server}).read(ctx, "source")
			}
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "history.sqlite")
			db, err := store.Open(ctx, path)
			if err != nil {
				t.Fatal(err)
			}
			scope, err := db.EnsureScope(ctx, store.Scope{APIOrigin: "o", UserID: "u", WorkspaceID: "w"})
			if err != nil {
				t.Fatal(err)
			}
			_, err = db.ImportConversation(ctx, store.NewConversation{ID: "import", ScopeID: scope, Provider: name, Cwd: "/fixture", CreatedAt: time.Now()}, importBatches("import", session.turns))
			if err != nil {
				t.Fatal(err)
			}
			if err = db.Close(); err != nil {
				t.Fatal(err)
			}
			db, err = store.Open(ctx, path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			events, err := db.EventsAfter(ctx, "import", 0, 1000, 100)
			if err != nil {
				t.Fatal(err)
			}
			var order []string
			evidence := false
			for _, e := range events {
				if e.Type != "item.completed" {
					continue
				}
				var payload map[string]any
				if err = json.Unmarshal([]byte(e.Payload), &payload); err != nil {
					t.Fatal(err)
				}
				if payload["kind"] == "assistant_text" {
					order = append(order, fmt.Sprint(payload["text"]))
				}
				if payload["source_item_id"] == "native-call" {
					order = append(order, "call")
					if payload["output"] != "partial failure" || payload["status"] != "failed" {
						t.Fatal(payload)
					}
					if name == "claude" {
						evidence = payload["file_changes_incomplete"] == true && payload["file_changes"] != nil
					}
					if name == "codex" && payload["duration_ms"] != float64(42) {
						t.Fatal(payload)
					}
				}
				if payload["kind"] == "file_change" {
					evidence = true
				}
			}
			if !reflect.DeepEqual(order, []string{"before", "call", "after"}) || !evidence {
				t.Fatalf("order=%v evidence=%v", order, evidence)
			}
		})
	}
}
