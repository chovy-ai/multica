package codex

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

type note struct{ method, params string }

func feed(t *testing.T, n *Normalizer, notes ...note) []Event {
	t.Helper()
	var out []Event
	for _, x := range notes {
		if !json.Valid([]byte(x.params)) {
			t.Fatalf("fixture is not JSON: %s", x.params)
		}
		out = append(out, n.Accept(x.method, json.RawMessage(x.params))...)
	}
	return out
}

func summary(events []Event) string {
	lines := make([]string, len(events))
	for i, e := range events {
		s := e.Type + " " + e.ItemID
		if e.Final {
			s += " final"
		}
		for _, k := range []string{"kind", "status", "text", "command", "output", "exit_code", "tool"} {
			if v, ok := e.Payload[k]; ok {
				s += fmt.Sprintf(" %s=%v", k, v)
			}
		}
		lines[i] = s
	}
	return strings.Join(lines, "\n")
}

func assertEvents(t *testing.T, got []Event, want ...string) {
	t.Helper()
	if summary(got) != strings.Join(want, "\n") {
		t.Fatalf("events:\n%s\nwant:\n%s", summary(got), strings.Join(want, "\n"))
	}
}

func TestCodexNormalizerStreamsAgentTextAndUsesCompletedText(t *testing.T) {
	t.Parallel()

	n := NewNormalizer("multica")
	got := feed(t, n,
		note{"item/started", `{"item":{"id":"a1","type":"agentMessage"}}`},
		note{"item/agentMessage/delta", `{"threadId":"th","turnId":"tu","itemId":"a1","delta":"测试"}`},
		note{"item/agentMessage/delta", `{"itemId":"a1","delta":"通过"}`},
		note{"item/completed", `{"item":{"id":"a1","type":"agentMessage","text":"测试全部通过。","phase":"final_answer"}}`},
		// Duplicate completion and late deltas never reopen the item.
		note{"item/completed", `{"item":{"id":"a1","type":"agentMessage","text":"again"}}`},
		note{"item/agentMessage/delta", `{"itemId":"a1","delta":"late"}`},
	)
	assertEvents(t, got,
		"item.started a1 kind=assistant_text",
		"item.delta a1 kind=assistant_text text=测试",
		"item.delta a1 kind=assistant_text text=通过",
		"item.completed a1 final kind=assistant_text status=completed text=测试全部通过。",
	)
	if got[3].Payload["phase"] != "final_answer" {
		t.Fatalf("phase = %v", got[3].Payload["phase"])
	}
}

func TestCodexNormalizerCommandsReasoningAndFileChanges(t *testing.T) {
	t.Parallel()

	got := feed(t, NewNormalizer("multica"),
		note{"item/completed", `{"item":{"id":"r1","type":"reasoning","summary":["plan"],"content":["detail"]}}`},
		note{"item/started", `{"item":{"id":"c1","type":"commandExecution","command":"pnpm test","cwd":"/repo"}}`},
		note{"item/completed", `{"item":{"id":"c1","type":"commandExecution","command":"pnpm test","cwd":"/repo","aggregatedOutput":"PASS\n","exitCode":0,"durationMs":5120,"status":"completed"}}`},
		note{"item/started", `{"item":{"id":"f1","type":"fileChange","changes":[{"path":"a.ts","kind":{"type":"update"}}]}}`},
		note{"item/completed", `{"item":{"id":"f1","type":"fileChange","status":"completed","changes":[{"path":"a.ts","kind":{"type":"update","move_path":"b.ts"},"diff":"@@"},{"path":"","kind":"add"}]}}`},
	)
	assertEvents(t, got,
		"item.completed r1 final kind=reasoning status=completed text=plan\ndetail",
		"item.started c1 kind=command command=pnpm test",
		"item.completed c1 final kind=command status=completed command=pnpm test output=PASS\n exit_code=0",
		"item.started f1 kind=file_change",
		"item.completed f1 final kind=file_change status=completed",
	)
	if got[2].Payload["duration_ms"] != int64(5120) {
		t.Fatalf("duration = %v", got[2].Payload["duration_ms"])
	}
	change := got[4].Payload["changes"].([]any)
	if len(change) != 1 || fmt.Sprint(change[0]) != "map[diff:@@ kind:move move_path:b.ts path:a.ts]" {
		t.Fatalf("changes = %v", change)
	}
}

func TestCodexNormalizerToolCallsImagesAndQuestions(t *testing.T) {
	t.Parallel()

	got := feed(t, NewNormalizer("multica"),
		note{"item/started", `{"item":{"id":"m1","type":"mcpToolCall","server":"multica","tool":"search_issues","arguments":{"q":"crash"}}}`},
		note{"item/completed", `{"item":{"id":"m1","type":"mcpToolCall","server":"multica","tool":"search_issues","status":"completed","result":{"content":[{"type":"text","text":"3 issues"},{"type":"image","mimeType":"image/png","data":"iVBORw0KGgo="}]}}}`},
		note{"item/completed", `{"item":{"id":"m2","type":"mcpToolCall","server":"github","tool":"get_pr","status":"failed","error":{"message":"timeout"}}}`},
		note{"item/started", `{"item":{"id":"q1","type":"mcpToolCall","server":"multica","tool":"ask_user_question","arguments":{}}}`},
		note{"item/completed", `{"item":{"id":"q1","type":"mcpToolCall","server":"multica","tool":"ask_user_question","status":"completed"}}`},
		note{"item/completed", `{"item":{"id":"g1","type":"imageGeneration","status":"completed","result":"iVBORw0KGgo="}}`},
		note{"item/completed", `{"item":{"id":"g2","type":"imageGeneration","status":"failed","result":""}}`},
	)
	assertEvents(t, got,
		"item.started m1 kind=tool_call tool=mcp__multica__search_issues",
		`item.completed m1 final kind=tool_call status=completed output={"content":[{"text":"3 issues","type":"text"}]} tool=mcp__multica__search_issues`,
		"item.completed output-image:m1:0 final kind=image status=completed",
		`item.completed m2 final kind=tool_call status=failed output={"message":"timeout"} tool=mcp__github__get_pr`,
		"item.completed g1 final kind=image status=completed",
	)
	if got[2].Image == nil || got[4].Image == nil || got[4].Image.MimeType != "image/png" {
		t.Fatalf("images = %+v / %+v", got[2].Image, got[4].Image)
	}
}

func TestCodexNormalizerCloseFinalizesOpenItems(t *testing.T) {
	t.Parallel()

	n := NewNormalizer("multica")
	feed(t, n,
		note{"item/agentMessage/delta", `{"itemId":"a1","delta":"half"}`},
		note{"item/started", `{"item":{"id":"c1","type":"commandExecution","command":"sleep 9"}}`},
		note{"item/started", `{"item":{"id":"f1","type":"fileChange"}}`},
	)
	assertEvents(t, n.Close("cancelled"),
		"item.completed a1 final kind=assistant_text status=cancelled text=half",
		"item.completed c1 final kind=command status=cancelled command=sleep 9 output= exit_code=<nil>",
		"item.completed f1 final kind=file_change status=cancelled",
	)
	if again := n.Close("cancelled"); len(again) != 0 {
		t.Fatalf("second Close = %s", summary(again))
	}
}

func TestCodexNormalizerIgnoresUnrelatedNotifications(t *testing.T) {
	t.Parallel()

	got := feed(t, NewNormalizer("multica"),
		note{"turn/started", `{"turn":{"id":"t"}}`},
		note{"thread/tokenUsage/updated", `{"turnId":"t"}`},
		note{"item/completed", `{"item":{"type":"agentMessage","text":"no id"}}`},
		note{"item/completed", `{"item":{"id":"x","type":"webSearch"}}`},
	)
	if len(got) != 0 {
		t.Fatalf("events = %s", summary(got))
	}
}
