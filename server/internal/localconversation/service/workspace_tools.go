package service

import (
	"context"

	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
	"github.com/multica-ai/multica/server/internal/localconversation/workspace"
)

// localActions lets workspace tools act on the scope's local
// conversations through the same paths as Desktop.
type localActions struct {
	s       *Service
	scopeID int64
}

func toolConversation(c sqlitedb.Conversation) workspace.Conversation {
	out := workspace.Conversation{ID: c.ID, Title: c.Title, Provider: c.Provider, Archived: c.Archived == 1, Pinned: c.Pinned == 1,
		ForkedFrom: c.ForkedFromID, ForkedFromTurnID: c.ForkedFromTurnID, SideSourceID: c.SideSourceID}
	if c.ProjectID.Valid {
		id := c.ProjectID.String
		out.ProjectID = &id
	}
	return out
}

func (l localActions) Create(ctx context.Context, provider, title string, projectID *string) (workspace.Conversation, error) {
	c, err := l.s.Create(ctx, CreateCommand{ScopeID: l.scopeID, ID: newID(), Provider: provider, Title: title, ProjectID: projectID})
	return toolConversation(c), err
}

func (l localActions) Update(ctx context.Context, id string, u workspace.LocalUpdate) (workspace.Conversation, error) {
	c, err := l.s.UpdateMetadata(ctx, l.scopeID, id, MetadataUpdate{Title: u.Title, Pinned: u.Pinned, Archived: u.Archived, SetProject: u.SetProject, ProjectID: u.ProjectID})
	return toolConversation(c), err
}

func (l localActions) Fork(ctx context.Context, id, turnID, requestID string) (workspace.Conversation, error) {
	c, err := l.s.Fork(ctx, ForkCommand{ScopeID: l.scopeID, SourceID: id, TurnID: turnID, RequestID: requestID})
	return toolConversation(c), err
}

func (l localActions) List(ctx context.Context) ([]workspace.Conversation, error) {
	rows, err := l.s.store.ScopeConversations(ctx, l.scopeID)
	if err != nil {
		return nil, err
	}
	out := make([]workspace.Conversation, len(rows))
	for i, c := range rows {
		out[i] = toolConversation(c)
	}
	return out, nil
}

func (l localActions) Send(ctx context.Context, id, content, model, requestID string) (string, error) {
	if model != "" {
		if err := l.s.UpdateSettings(ctx, l.scopeID, id, SettingsUpdate{Model: &model}); err != nil {
			return "", err
		}
	}
	result, err := l.s.Send(ctx, SendCommand{ScopeID: l.scopeID, ConversationID: id, RequestID: requestID, Text: content})
	return result.TurnID, err
}

// Cancel interrupts the conversation's running turn when it is turnID.
func (l localActions) Cancel(ctx context.Context, id, turnID string) error {
	running, err := l.s.store.RunningTurns(ctx)
	if err != nil {
		return err
	}
	for _, t := range running {
		if t.ConversationID == id && t.ID == turnID {
			return l.s.Interrupt(ctx, l.scopeID, id)
		}
	}
	return ErrNoRunningTurn
}
