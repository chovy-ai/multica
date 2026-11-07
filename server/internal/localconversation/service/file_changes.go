package service

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/multica-ai/multica/server/internal/localconversation/filechanges"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

const ConversationResourcesCapability = "conversation-resources-v1"

func codexFileCollection(c *filechanges.Capture, turn string, events []outputEvent) filechanges.Collection {
	collection := filechanges.Collection{Capture: c, TurnID: turn}
	for _, e := range events {
		if !e.Final || e.Payload["kind"] != "file_change" {
			continue
		}
		changes, _ := e.Payload["changes"].([]any)
		for i, raw := range changes {
			entry, _ := raw.(map[string]any)
			path, _ := entry["path"].(string)
			move, _ := entry["move_path"].(string)
			kind, _ := entry["kind"].(string)
			patch, _ := entry["diff"].(string)
			if path != "" {
				collection.Native = append(collection.Native, filechanges.NativeChange{OperationID: fmt.Sprintf("%s:%s:%d", turn, e.ItemID, i), Path: path, MovePath: move, Kind: kind, Patch: patch, Success: e.Payload["status"] == "completed"})
			}
		}
	}
	return collection
}

// ResourcePage is independent of transcript pagination and always scope checked.
func (s *Service) ResourcePage(ctx context.Context, scopeID int64, id, cursor string) (store.ResourcePage, error) {
	if _, err := s.scopedConversation(ctx, scopeID, id); err != nil {
		return store.ResourcePage{}, err
	}
	return s.store.ResourcePage(ctx, id, cursor)
}

func (s *Service) ChangeDetail(ctx context.Context, scopeID int64, id, fileID string, revision int64) (store.ChangeDetail, error) {
	if _, err := s.scopedConversation(ctx, scopeID, id); err != nil {
		return store.ChangeDetail{}, err
	}
	return s.store.ChangeDetail(ctx, id, fileID, revision)
}

// claudeFileObservation treats adapter evidence as untrusted input at the scope boundary.
func claudeFileObservation(raw json.RawMessage, cwd, turn string) (filechanges.Observation, error) {
	var frame struct {
		ToolID string               `json:"tool_id"`
		Path   string               `json:"path"`
		Before filechanges.Snapshot `json:"before"`
		After  filechanges.Snapshot `json:"after"`
		Reason string               `json:"reason"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		return filechanges.Observation{}, err
	}
	path, reason := filechanges.Relative(cwd, frame.Path)
	if reason != "" {
		frame.Reason = reason
	}
	if frame.ToolID == "" || path == "" || len(frame.Before.Content) > filechanges.MaxFileBytes || len(frame.After.Content) > filechanges.MaxFileBytes {
		return filechanges.Observation{}, ErrInvalidRequest
	}
	if frame.Before.Reason != "" {
		frame.Reason = frame.Before.Reason
	}
	if frame.After.Reason != "" {
		frame.Reason = frame.After.Reason
	}
	if frame.Reason == "" && (frame.Before.Hash != filechanges.Hash(frame.Before.Content) || frame.After.Hash != filechanges.Hash(frame.After.Content)) {
		frame.Reason = "uncertain"
	}
	return filechanges.Observation{OperationID: turn + ":claude:" + frame.ToolID, Cwd: filepath.Clean(cwd), Path: path, TurnID: turn, Before: frame.Before, After: frame.After, Reason: frame.Reason}, nil
}
