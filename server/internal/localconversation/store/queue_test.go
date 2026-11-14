package store

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestQueueReorderRollsBackWithFailedCommit(t *testing.T) {
	t.Parallel()
	s, _ := openTestStore(t)
	createConversation(t, s, "conv")
	w := s.NewWriter(WriterOptions{})
	t.Cleanup(w.Close)
	ctx := context.Background()
	for index, id := range []string{"a", "b", "c"} {
		item := json.RawMessage(fmt.Sprintf(`{"requestId":%q,"attachmentIds":["image"],"references":[{"kind":"file","path":"/repo/a"}]}`, id))
		if _, err := w.Submit(ctx, Batch{ConversationID: "conv", Queue: &QueueChange{Revision: int64(index + 1), Paused: true, Error: "held", Append: &QueueItem{RequestID: id, Item: item, OriginPeerID: "peer", OriginClientKind: "desktop"}}}); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := s.Queue(ctx, "conv")
	change := &QueueChange{Revision: 4, Paused: true, Error: "held", Order: []string{"c", "a", "b"}}
	if _, err := w.Submit(ctx, Batch{ConversationID: "conv", Queue: change, Events: []NewEvent{event("", "", "queue.updated", false, "{")}}); err == nil {
		t.Fatal("accepted an invalid event")
	}
	after, _ := s.Queue(ctx, "conv")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("failed commit changed queue: %+v -> %+v", before, after)
	}
	if _, err := w.Submit(ctx, Batch{ConversationID: "conv", Queue: change}); err != nil {
		t.Fatal(err)
	}
	after, _ = s.Queue(ctx, "conv")
	for index, original := range []int{2, 0, 1} {
		if !reflect.DeepEqual(after.Items[index], before.Items[original]) {
			t.Fatalf("reorder changed message payload: %+v", after.Items[index])
		}
	}
}
