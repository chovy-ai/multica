// Package provider defines the events shared by live runners and history adapters.
package provider

// Event is a provider-neutral item update. The conversation recorder assigns
// local turn IDs, sequence numbers and attachment references before persistence.
type Event struct {
	ItemID  string
	Type    string
	Final   bool
	Payload map[string]any
	Image   *InlineImage
}

type InlineImage struct{ MimeType, Data string }

// Transcript collects final states in the order their items first appeared.
// History uses the same adapter events as live execution, including replacement
// finals and stable native IDs, rather than projecting a second tool vocabulary.
type Transcript struct {
	order  []string
	seen   map[string]bool
	finals map[string]Event
}

func (t *Transcript) Add(events ...Event) {
	if t.seen == nil {
		t.seen = map[string]bool{}
		t.finals = map[string]Event{}
	}
	for _, e := range events {
		if e.ItemID == "" {
			continue
		}
		if !t.seen[e.ItemID] {
			t.seen[e.ItemID] = true
			t.order = append(t.order, e.ItemID)
		}
		if e.Final {
			t.finals[e.ItemID] = e
		}
	}
}

func (t *Transcript) Events() []Event {
	var out []Event
	for _, id := range t.order {
		if e, ok := t.finals[id]; ok {
			out = append(out, e)
		}
	}
	return out
}

// FileChanges returns the same reported evidence for standalone native edits
// and edits attached to an existing command. It never proves a disk baseline.
func FileChanges(payload map[string]any) []any {
	if payload["kind"] == "file_change" {
		changes, _ := payload["changes"].([]any)
		return changes
	}
	changes, _ := payload["file_changes"].([]any)
	return changes
}
