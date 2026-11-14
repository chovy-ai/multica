package claude

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestToolResultRetainsReportedChangesWithoutAddingCalls(t *testing.T) {
	for _, tc := range []struct {
		name, diff string
		incomplete bool
	}{
		{"hunks", `{"files":[{"filePath":"notes.md","hunks":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-old","+new"]}]}],"changedFiles":["notes.md"],"moreFiles":0}`, false},
		{"paths only", `{"files":[],"changedFiles":["notes.md"],"moreFiles":1}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := NewNormalizer("multica")
			starts := feed(t, n, `{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"call","name":"Bash","input":{"command":"fixture","description":"edit notes","timeout":1000}}]}}`)
			finals := feed(t, n, `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call","content":"ok"}]},"tool_use_result":{"stdout":"ok","stderr":"","bashEditDiff":`+tc.diff+`}}`)
			if len(starts) != 1 || len(finals) != 1 || finals[0].ItemID != "call" {
				t.Fatalf("tool count/identity changed: %+v %+v", starts, finals)
			}
			state := finals[0].Payload
			changes := state["file_changes"].([]any)
			if len(changes) != 1 || changes[0].(map[string]any)["path"] != "notes.md" {
				t.Fatal(state)
			}
			if state["file_changes_incomplete"] == true != tc.incomplete {
				t.Fatal(state)
			}
			if !tc.incomplete && !strings.Contains(changes[0].(map[string]any)["diff"].(string), "@@ -1,1 +1,1 @@\n-old\n+new\n") {
				t.Fatal(changes)
			}
			if state["result"].(map[string]any)["stdout"] != "ok" || state["output"] != "ok" {
				t.Fatal(state)
			}
			if len(n.Accept(json.RawMessage(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call","content":"again"}]}}`))) != 0 {
				t.Fatal("duplicate result reopened call")
			}
		})
	}
}

func TestStructuredToolResultAndProgress(t *testing.T) {
	n := NewNormalizer("multica")
	feed(t, n, `{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"c","name":"WebFetch","input":{"url":"https://example.com"}}]}}`)
	progress := feed(t, n, `{"type":"tool_progress","tool_use_id":"c","elapsed_time_seconds":3}`)
	if len(progress) != 1 || progress[0].Final || progress[0].Payload["elapsed_seconds"] != float64(3) {
		t.Fatal(progress)
	}
	events := feed(t, n, `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c","is_error":true,"content":"missing"}]},"tool_use_result":{"code":404,"durationMs":42,"url":"https://example.com/final"}}`)
	if len(events) != 1 || events[0].Payload["status"] != "failed" || events[0].Payload["result"].(map[string]any)["code"] != float64(404) {
		t.Fatal(events)
	}
}

func TestBackgroundTaskPreservesOutputReferences(t *testing.T) {
	n := NewNormalizer("multica")
	feed(t, n, `{"type":"system","subtype":"task_started","task_id":"t","run_id":"r","tool_use_id":"c","description":"fixture"}`)
	got := feed(t, n, `{"type":"system","subtype":"task_notification","task_id":"t","status":"completed","summary":"done","output_file":"/fixture/output","resource_links":[{"uri":"https://example.com/artifact","name":"artifact"}]}`)
	if len(got) != 1 || got[0].Payload["output_file"] != "/fixture/output" || got[0].Payload["run_id"] != "r" {
		t.Fatal(got)
	}
	if len(got[0].Payload["resource_links"].([]any)) != 1 {
		t.Fatal(got)
	}
}
