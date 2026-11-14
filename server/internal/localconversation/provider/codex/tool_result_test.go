package codex

import "testing"

func TestCommandOutputDeltaSurvivesCancellation(t *testing.T) {
	n := NewNormalizer("multica")
	feed(t, n, note{"item/started", `{"item":{"id":"c","type":"commandExecution","command":"fixture"}}`})
	got := feed(t, n, note{"item/commandExecution/outputDelta", `{"itemId":"c","delta":"partial\n"}`})
	if len(got) != 1 || got[0].Payload["field"] != "output" {
		t.Fatal(got)
	}
	final := n.Close("cancelled")
	if len(final) != 1 || final[0].Payload["output"] != "partial\n" || final[0].Payload["status"] != "cancelled" {
		t.Fatal(final)
	}
}

func TestWebSearchAndStructuredMcpResults(t *testing.T) {
	got := feed(t, NewNormalizer("multica"),
		note{"item/completed", `{"item":{"id":"w","type":"webSearch","query":"fixture","action":{"type":"search","query":"fixture"}}}`},
		note{"item/completed", `{"item":{"id":"m","type":"mcpToolCall","server":"fixture","tool":"lookup","status":"completed","result":{"content":[],"structuredContent":{"count":3}}}}`},
	)
	if len(got) != 2 || got[0].Payload["tool"] != "WebSearch" || got[1].Payload["tool"] != "lookup" || got[1].Payload["server"] != "fixture" {
		t.Fatal(got)
	}
	result := got[1].Payload["result"].(map[string]any)
	if result["structuredContent"].(map[string]any)["count"] != float64(3) {
		t.Fatal(result)
	}
}

func TestNullableCommandFinalKeepsStreamedOutput(t *testing.T) {
	n := NewNormalizer("multica")
	feed(t, n, note{"item/started", `{"item":{"id":"c","type":"commandExecution","command":"fixture"}}`}, note{"item/commandExecution/outputDelta", `{"itemId":"c","delta":"partial"}`})
	got := feed(t, n, note{"item/completed", `{"item":{"id":"c","type":"commandExecution","command":"fixture","status":"interrupted","aggregatedOutput":null}}`})
	if len(got) != 1 || got[0].Payload["output"] != "partial" || got[0].Payload["status"] != "cancelled" {
		t.Fatal(got)
	}
}
