package service

import (
	"context"
	"sync"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/title"
)

// titleRuns tracks model title generations, so a rename or shutdown can
// cancel them.
type titleRuns struct {
	mu     sync.Mutex
	cancel map[string]context.CancelFunc
}

// firstTitle is the summary title of a conversation's first message, when
// the conversation still has its default automatic title.
func firstTitle(turnCount int64, mode, current, text string) *string {
	if turnCount > 0 || mode != "auto" || !title.IsDefault(current) {
		return nil
	}
	t := title.Summarize(text)
	return &t
}

func (s *Service) cancelTitle(conversationID string) {
	s.titles.mu.Lock()
	cancel := s.titles.cancel[conversationID]
	s.titles.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// generateTitle asks the provider for a title once the conversation is
// idle: its automatic title was never generated, it is neither a fork nor
// an import, and no queued message is about to run. A title-only update
// keeps the conversation's place in the list.
func (s *Service) generateTitle(conversationID string) {
	if s.opts.Catalog == nil || s.isClosing() {
		return
	}
	ctx := context.Background()
	conv, err := s.store.Conversation(ctx, conversationID)
	if err != nil || conv.TitleMode != "auto" || conv.ForkedFromID != "" || conv.ImportedFromSessionID != "" ||
		conv.TitleGeneration == "complete" || conv.TitleGeneration == "failed" || conv.TurnCount == 0 {
		return
	}
	if queue, err := s.store.Queue(ctx, conversationID); err != nil || (!queue.Paused && len(queue.Items) > 0) {
		return
	}
	messages, err := s.store.Messages(ctx, conversationID)
	if err != nil {
		return
	}
	var first *string
	for i := range messages {
		if messages[i].Role == "user" {
			first = &messages[i].Content
			break
		}
	}
	if first == nil {
		return
	}
	exe, err := s.opts.Catalog.Executable(ctx, conv.Provider)
	if err != nil {
		return
	}

	runCtx, cancel := context.WithCancel(ctx)
	s.titles.mu.Lock()
	if s.titles.cancel[conversationID] != nil {
		s.titles.mu.Unlock()
		cancel()
		return
	}
	s.titles.cancel[conversationID] = cancel
	s.titles.mu.Unlock()
	defer func() {
		s.titles.mu.Lock()
		delete(s.titles.cancel, conversationID)
		s.titles.mu.Unlock()
		cancel()
	}()
	if !s.setTitle(conversationID, "pending", nil) {
		return
	}
	model := ""
	if conv.Model.Valid {
		model = conv.Model.String
	}
	generated, err := title.Generate(runCtx, title.Request{Provider: conv.Provider, Executable: exe, Model: model, Content: *first})
	switch {
	case runCtx.Err() != nil:
		// Renamed or shutting down: the user's title or the next idle wins.
		s.setTitle(conversationID, "", nil)
	case err != nil:
		s.setTitle(conversationID, "failed", nil)
	default:
		s.setTitle(conversationID, "complete", &generated)
	}
}

// setTitle records the title generation state, and the title, while the
// title is still automatic. It reports whether it changed anything.
func (s *Service) setTitle(conversationID, state string, generated *string) bool {
	s.metaMu.Lock()
	defer s.metaMu.Unlock()
	ctx := context.Background()
	conv, err := s.store.Conversation(ctx, conversationID)
	if err != nil || conv.TitleMode != "auto" {
		return false
	}
	meta := metadataOf(conv)
	meta.TitleGeneration = state
	batch := store.Batch{ConversationID: conversationID, Metadata: &meta,
		Summary: &store.SummaryPatch{Title: generated, UpdatedAt: s.opts.Now(), KeepRecency: true}}
	_, err = s.batcher.AppendWait(ctx, batch)
	return err == nil
}
