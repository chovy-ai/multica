package provider

import "testing"

func TestTranscriptKeepsFirstAppearanceAndOneFinalPerItem(t *testing.T) {
	var transcript Transcript
	transcript.Add(Event{ItemID: "text", Type: "item.completed", Final: true, Payload: map[string]any{"text": "before"}}, Event{ItemID: "call", Type: "item.started"})
	transcript.Add(Event{ItemID: "after", Final: true}, Event{ItemID: "call", Final: true, Payload: map[string]any{"output": "first"}}, Event{ItemID: "call", Final: true, Payload: map[string]any{"output": "final"}})
	got := transcript.Events()
	if len(got) != 3 || got[0].ItemID != "text" || got[1].ItemID != "call" || got[2].ItemID != "after" || got[1].Payload["output"] != "final" {
		t.Fatal(got)
	}
}
