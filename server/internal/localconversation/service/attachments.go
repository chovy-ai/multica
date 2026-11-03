package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

type attachmentUpload struct {
	ID       string `json:"attachment_id,omitempty"`
	Error    string `json:"error,omitempty"`
	Rejected bool   `json:"rejected,omitempty"`
}

// uploadAttachments accepts stored attachment IDs, never arbitrary file paths.
// A receipt survives provider turns and retains ambiguous upload outcomes.
func (s *Service) uploadAttachments(ctx context.Context, scopeID int64, cloud cloudAgents, ids []string) ([]string, error) {
	for _, id := range ids {
		if _, _, err := s.store.Attachment(ctx, scopeID, id); err != nil {
			return nil, errors.New("Attachment was not found in this account and workspace")
		}
	}
	var uploaded []string
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		cloudID, err := s.uploadAttachment(ctx, scopeID, cloud, id)
		if err != nil {
			return nil, err
		}
		uploaded = append(uploaded, cloudID)
	}
	return uploaded, nil
}

func (s *Service) uploadAttachment(ctx context.Context, scopeID int64, cloud cloudAgents, id string) (string, error) {
	lockKey := fmt.Sprintf("%d:%s", scopeID, id)
	value, _ := s.attachmentUploads.LoadOrStore(lockKey, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	a, path, err := s.store.Attachment(ctx, scopeID, id)
	if err != nil {
		return "", err
	}
	key := "attachment-upload:" + id
	prior, err := s.store.ClaimReceipt(ctx, store.CommandReceipt{ScopeID: scopeID, RequestID: key, Fingerprint: id, Result: `{}`, CreatedAt: s.opts.Now()})
	if err != nil {
		return "", err
	}
	var state attachmentUpload
	if prior != nil {
		if err := json.Unmarshal([]byte(prior.Result), &state); err != nil {
			return "", err
		}
	}
	if prior == nil || state.Rejected {
		if err := s.store.SetReceiptResult(ctx, scopeID, key, `{}`); err != nil {
			return "", err
		}
		state = attachmentUpload{}
		name := a.FileName
		if name == "" {
			name = filepath.Base(path)
		}
		cloudID, _, uploadErr := cloud.Upload(ctx, path, name, a.MediaType)
		if uploadErr != nil || cloudID == "" {
			state.Error = fmt.Sprintf("Upload of attachment %s was not confirmed. Inspect cloud state before uploading again", id)
			var op *contextmcp.OperationError
			if errors.As(uploadErr, &op) && op.Status >= 400 && op.Status < 500 {
				state.Rejected = true
				state.Error = "Attachment upload was rejected: " + op.Error()
			}
		} else {
			state.ID = cloudID
		}
		data, _ := json.Marshal(state)
		if err := s.store.SetReceiptResult(context.WithoutCancel(ctx), scopeID, key, string(data)); err != nil {
			return "", fmt.Errorf("Upload receipt could not be saved; inspect cloud state before retrying: %w", err)
		}
	}
	if state.Error != "" {
		return "", errors.New(state.Error)
	}
	if state.ID == "" {
		return "", errors.New("A previous attachment upload is pending or unknown; inspect cloud state before retrying")
	}
	return state.ID, nil
}

type attachmentWrite struct {
	Completed bool   `json:"completed"`
	Value     any    `json:"value,omitempty"`
	Error     string `json:"error,omitempty"`
}

// attachmentWriteTool retains the outcome across MCP bindings, so retrying
// after a failed binding/readback cannot create a second task or comment.
func (s *Service) attachmentWriteTool(scopeID int64, conversationID string, tool contextmcp.Tool) contextmcp.Tool {
	call := tool.Call
	tool.Call = func(ctx context.Context, raw json.RawMessage) (contextmcp.Result, error) {
		var args map[string]any
		if json.Unmarshal(raw, &args) != nil {
			return call(ctx, raw)
		}
		requestID, _ := args["request_id"].(string)
		local, _ := args["local_attachment_ids"].([]any)
		cloud, _ := args["attachment_ids"].([]any)
		if len(local)+len(cloud) == 0 || !nativeID.MatchString(requestID) || len(requestID) > 128 {
			return call(ctx, raw)
		}
		canonical, _ := json.Marshal(args)
		sum := sha256.Sum256(canonical)
		fingerprint := hex.EncodeToString(sum[:])
		key := "attachment-write:" + conversationID + ":" + tool.Name + ":" + requestID
		prior, err := s.store.ClaimReceipt(ctx, store.CommandReceipt{ScopeID: scopeID, RequestID: key, Fingerprint: fingerprint, Result: `{}`, CreatedAt: s.opts.Now()})
		if err != nil {
			return contextmcp.Result{}, err
		}
		var state attachmentWrite
		if prior != nil {
			if prior.Fingerprint != fingerprint {
				return contextmcp.Result{}, errors.New("This request_id belongs to different attachment write arguments")
			}
			if err := json.Unmarshal([]byte(prior.Result), &state); err != nil {
				return contextmcp.Result{}, err
			}
		} else {
			result, callErr := call(ctx, raw)
			state.Completed, state.Value = true, result.Value
			if callErr != nil {
				state.Error = callErr.Error()
			}
			data, _ := json.Marshal(state)
			if err := s.store.SetReceiptResult(context.WithoutCancel(ctx), scopeID, key, string(data)); err != nil {
				return contextmcp.Result{}, fmt.Errorf("Write receipt could not be saved; inspect the target before retrying: %w", err)
			}
		}
		if !state.Completed {
			return contextmcp.Result{}, errors.New("The attachment write is pending or unknown. Inspect the target before retrying; it will not be replayed")
		}
		if state.Error != "" {
			return contextmcp.Result{}, errors.New(state.Error)
		}
		return contextmcp.Result{Value: state.Value}, nil
	}
	return tool
}
