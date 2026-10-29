package workspace

import (
	"context"
	"errors"
	"net/http"
	"net/url"
)

// Conversation is a local conversation as the tools report it.
type Conversation struct {
	ID               string  `json:"id"`
	Title            string  `json:"title"`
	Provider         string  `json:"provider"`
	Archived         bool    `json:"archived"`
	Pinned           bool    `json:"pinned"`
	ProjectID        *string `json:"project_id"`
	ForkedFrom       string  `json:"forked_from,omitempty"`
	ForkedFromTurnID string  `json:"forked_from_turn_id,omitempty"`
	SideSourceID     string  `json:"side_source_id,omitempty"`
	SideSourceTurnID string  `json:"side_source_turn_id,omitempty"`
}

// LocalUpdate changes a local conversation; nil fields keep their value.
type LocalUpdate struct {
	Title      *string
	Pinned     *bool
	Archived   *bool
	SetProject bool
	ProjectID  *string
}

// Local acts on this account's local conversations in the workspace.
type Local interface {
	Create(ctx context.Context, provider, title string, projectID *string) (Conversation, error)
	Update(ctx context.Context, id string, u LocalUpdate) (Conversation, error)
	Fork(ctx context.Context, id, turnID, requestID string) (Conversation, error)
	List(ctx context.Context) ([]Conversation, error)
	Send(ctx context.Context, id, content, model, requestID string) (turnID string, err error)
	Cancel(ctx context.Context, id, turnID string) error
}

func optionalString(in row, key string) (*string, bool) {
	v, present := in[key]
	if !present {
		return nil, false
	}
	s, ok := v.(string)
	if !ok {
		return nil, true
	}
	return &s, true
}

func (k *toolkit) cloud() error {
	if k.opts.Request == nil {
		return errors.New("Official cloud Multica operations are unavailable. Reconnect the desktop login/runtime.")
	}
	return nil
}

func (k *toolkit) localTools() {
	local := k.opts.Local
	k.tool("create_conversation", "Create a local Codex/Claude Code conversation or an official cloud chat with a defined Multica agent. Does not send a message. Local project grouping and cloud project_id use the current workspace.",
		row{"source": sSource, "title": sShort, "provider": enum("codex", "claude"), "agent_id": sID, "project_id": sNullID}, nil, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			project, _ := optionalString(in, "project_id")
			if project != nil {
				if err := k.cloud(); err != nil {
					return nil, err
				}
				if _, err := k.ensure(ctx, "project", *project); err != nil {
					return nil, err
				}
			}
			if str(in, "source") != "cloud" {
				if str(in, "provider") == "" {
					return nil, errors.New("Choose a local provider: codex or claude")
				}
				c, err := local.Create(ctx, str(in, "provider"), str(in, "title"), project)
				if err != nil {
					return nil, err
				}
				return row{"source": "local", "id": c.ID, "title": c.Title, "project_id": c.ProjectID, "provider": c.Provider}, nil
			}
			if err := k.cloud(); err != nil {
				return nil, err
			}
			agent := str(in, "agent_id")
			if agent == "" {
				return nil, errors.New("Cloud conversations require a defined agent_id")
			}
			if _, err := k.ensure(ctx, "agent", agent); err != nil {
				return nil, err
			}
			v, err := k.do(ctx, http.MethodPost, roots["conversation"], row{"agent_id": agent, "title": str(in, "title"), "project_id": in["project_id"]})
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "conversation", "created", v, "")
		})

	k.tool("update_conversation", "Rename, pin, archive/unarchive, or regroup a saved conversation. Local and cloud histories remain distinct. Cannot archive the conversation currently executing this tool.",
		row{"source": sSource, "id": sID, "title": sShort, "pinned": sBool, "archived": sBool, "project_id": sNullID}, []string{"id"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			id := str(in, "id")
			fields := without(in, "source", "id")
			if archived, _ := boolean(in, "archived"); archived && id == k.opts.ConversationID {
				return nil, errors.New("Cannot archive the currently executing conversation")
			}
			if _, err := nonempty(fields); err != nil {
				return nil, err
			}
			project, setProject := optionalString(in, "project_id")
			if project != nil {
				if err := k.cloud(); err != nil {
					return nil, err
				}
				if _, err := k.ensure(ctx, "project", *project); err != nil {
					return nil, err
				}
			}
			if str(in, "source") != "cloud" {
				u := LocalUpdate{SetProject: setProject, ProjectID: project}
				u.Title, _ = optionalString(in, "title")
				if v, ok := boolean(in, "pinned"); ok {
					u.Pinned = &v
				}
				if v, ok := boolean(in, "archived"); ok {
					u.Archived = &v
				}
				c, err := local.Update(ctx, id, u)
				if err != nil {
					return nil, err
				}
				return row{"source": "local", "id": c.ID, "title": c.Title, "pinned": c.Pinned, "archived": c.Archived, "project_id": c.ProjectID}, nil
			}
			if err := k.cloud(); err != nil {
				return nil, err
			}
			if _, err := k.ensure(ctx, "conversation", id); err != nil {
				return nil, err
			}
			if setProject {
				return nil, errors.New("The official chat API does not support moving an existing chat to another project")
			}
			base := roots["conversation"] + "/" + url.PathEscape(id)
			for _, patch := range []struct{ key, path string }{{"title", ""}, {"pinned", "/pin"}, {"archived", "/archive"}} {
				if v, ok := in[patch.key]; ok {
					if _, err := k.do(ctx, http.MethodPatch, base+patch.path, row{patch.key: v}); err != nil {
						return nil, err
					}
				}
			}
			current, err := k.ensure(ctx, "conversation", id)
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "conversation", "updated", current, "")
		})

	k.tool("fork_conversation", "Fork a saved local conversation through a settled turn. The new conversation retains its source lineage. Omit turn_id to fork the full settled history; a running selected turn cannot be forked.",
		row{"id": sID, "turn_id": sID}, []string{"id"}, true,
		func(ctx context.Context, in row, requestID string) (any, error) {
			c, err := local.Fork(ctx, str(in, "id"), str(in, "turn_id"), requestID)
			if err != nil {
				return nil, err
			}
			return row{"source": "local", "id": c.ID, "title": c.Title, "forked_from": c.ForkedFrom, "forked_from_turn_id": c.ForkedFromTurnID, "fork_mode": "native", "provider": c.Provider}, nil
		})

	k.tool("list_conversation_branches", "Find saved local conversations, Forks and Side conversations by their source ID. Use the returned IDs with read_context or update_conversation; native provider session IDs are not exposed.",
		row{"source_id": sID}, nil, false,
		func(ctx context.Context, in row, _ string) (any, error) {
			all, err := local.List(ctx)
			if err != nil {
				return nil, err
			}
			source := str(in, "source_id")
			items := []Conversation{}
			for _, c := range all {
				if source == "" || c.ID == source || c.ForkedFrom == source || c.SideSourceID == source {
					items = append(items, c)
				}
			}
			return row{"items": items}, nil
		})

	k.tool("send_conversation_message", "Send a user-requested message to another saved conversation. Starts model execution and may consume quota. Cannot send into the local conversation currently executing this tool. Read local output with read_execution/read_context, official output with run_messages/read_context.",
		row{"source": sSource, "id": sID, "content": row{"type": "string", "minLength": 1, "maxLength": 100000}, "model": row{"type": "string", "maxLength": 200}}, []string{"id", "content"}, true,
		func(ctx context.Context, in row, requestID string) (any, error) {
			id, content, model := str(in, "id"), str(in, "content"), str(in, "model")
			if str(in, "source") != "cloud" {
				if id == k.opts.ConversationID {
					return nil, errors.New("Cannot recursively send into the current conversation")
				}
				turn, err := local.Send(ctx, id, content, model, requestID)
				if err != nil {
					return nil, err
				}
				return row{"source": "local", "conversation_id": id, "turn_id": turn, "status": "submitted"}, nil
			}
			if err := k.cloud(); err != nil {
				return nil, err
			}
			if _, err := k.ensure(ctx, "conversation", id); err != nil {
				return nil, err
			}
			body := row{"content": content}
			if model != "" {
				body["model"] = model
			}
			v, err := k.do(ctx, http.MethodPost, roots["conversation"]+"/"+url.PathEscape(id)+"/messages", body)
			if err != nil {
				return nil, err
			}
			out := row{"source": "cloud", "conversation_id": id}
			if result, ok := v.(row); ok {
				for key, value := range result {
					out[key] = value
				}
			}
			return out, nil
		})

	k.tool("cancel_local_conversation_run", "Cancel a user-selected execution in another local conversation. Does not stop a runtime or the conversation currently executing this MCP tool.",
		row{"conversation_id": sID, "turn_id": sID}, []string{"conversation_id", "turn_id"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			id, turn := str(in, "conversation_id"), str(in, "turn_id")
			if id == k.opts.ConversationID {
				return nil, errors.New("Cannot cancel the execution currently serving this tool")
			}
			if err := local.Cancel(ctx, id, turn); err != nil {
				return nil, err
			}
			return row{"conversation_id": id, "turn_id": turn, "status": "cancellation_requested"}, nil
		})
}
