package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/filechanges"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

type FileResource struct {
	ID            string `json:"id"`
	Cwd           string `json:"cwd"`
	Path          string `json:"path"`
	OldPath       string `json:"old_path,omitempty"`
	Kind          string `json:"kind"`
	Reason        string `json:"reason,omitempty"`
	Added         *int   `json:"added"`
	Deleted       *int   `json:"deleted"`
	Changed       bool   `json:"changed"`
	InitialExists bool   `json:"initial_exists"`
	CurrentExists bool   `json:"current_exists"`
	TurnID        string `json:"turn_id"`
}

type ResourcePage struct {
	Revision     int64                `json:"revision"`
	Coverage     string               `json:"coverage"`
	Reason       string               `json:"reason"`
	RecordedFrom string               `json:"recorded_from"`
	Files        []FileResource       `json:"files"`
	Attachments  []ResourceAttachment `json:"attachments"`
	NextCursor   *string              `json:"next_cursor"`
}

type ResourceAttachment struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Size      int64  `json:"size"`
	Source    string `json:"source"`
}

type ChangeDetail struct {
	File     FileResource `json:"file"`
	Revision int64        `json:"revision"`
	Patch    string       `json:"patch"`
	Before   string       `json:"before"`
	After    string       `json:"after"`
}

var ErrResourceRevision = errors.New("local conversation: resources changed; reload the list")

func (s *Store) ResourcePage(ctx context.Context, id, cursor string) (ResourcePage, error) {
	tx, err := s.read.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ResourcePage{}, err
	}
	defer tx.Rollback()
	q := sqlitedb.New(tx)
	page := ResourcePage{Coverage: "missing_baseline", Files: []FileResource{}, Attachments: []ResourceAttachment{}}
	st, err := q.GetResourceState(ctx, id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return page, err
	}
	if errors.Is(err, sql.ErrNoRows) {
		if conv, e := q.GetConversation(ctx, id); e == nil && conv.TurnCount == 0 {
			page.Coverage = "complete"
		}
	}
	if err == nil {
		page.Revision, page.Coverage, page.Reason, page.RecordedFrom = st.Revision, st.Coverage, st.Reason, st.RecordedFrom
	}
	pending, err := q.PendingResourceCaptures(ctx, id)
	if err != nil {
		return page, err
	}
	if pending > 0 {
		page.Coverage, page.Reason = "partial", "uncertain"
	}
	after := ""
	if cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			return page, ErrResourceRevision
		}
		var value struct {
			ID       string
			Revision int64
			After    string
		}
		if json.Unmarshal(raw, &value) != nil || value.ID != id || value.Revision != page.Revision {
			return page, ErrResourceRevision
		}
		after = value.After
	}
	rows, err := q.ListResourceEntries(ctx, sqlitedb.ListResourceEntriesParams{ConversationID: id, CursorID: after, Limit: 201})
	if err != nil {
		return page, err
	}
	if len(rows) > 200 {
		raw, _ := json.Marshal(struct {
			ID       string
			Revision int64
			After    string
		}{id, page.Revision, fmt.Sprint(rows[199].CursorID)})
		next := base64.RawURLEncoding.EncodeToString(raw)
		page.NextCursor = &next
		rows = rows[:200]
	}
	for _, row := range rows {
		if row.EntryType == "attachment" {
			var a ResourceAttachment
			if err := json.Unmarshal([]byte(row.Metadata), &a); err != nil {
				return page, err
			}
			page.Attachments = append(page.Attachments, a)
			continue
		}
		var f FileResource
		if err := json.Unmarshal([]byte(row.Metadata), &f); err != nil {
			return page, err
		}
		if f.Changed {
			page.Files = append(page.Files, f)
		}
	}
	return page, tx.Commit()
}

func (s *Store) ChangeDetail(ctx context.Context, id, fileID string, revision int64) (ChangeDetail, error) {
	tx, err := s.read.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ChangeDetail{}, err
	}
	defer tx.Rollback()
	q := sqlitedb.New(tx)
	state, err := q.GetResourceState(ctx, id)
	if err != nil {
		return ChangeDetail{}, ErrNotFound
	}
	if state.Revision != revision {
		return ChangeDetail{}, ErrResourceRevision
	}
	row, err := q.GetFileChange(ctx, sqlitedb.GetFileChangeParams{ConversationID: id, ID: fileID})
	if errors.Is(err, sql.ErrNoRows) {
		return ChangeDetail{}, ErrNotFound
	}
	if err != nil {
		return ChangeDetail{}, err
	}
	var f FileResource
	if err = json.Unmarshal([]byte(row.Metadata), &f); err != nil {
		return ChangeDetail{}, err
	}
	detail := ChangeDetail{File: f, Revision: state.Revision}
	// Uncertain records retain the last trusted bytes internally, never serve them as current evidence.
	if f.Reason == "" {
		detail.Patch, detail.Before, detail.After = row.Patch, row.Baseline, row.Latest
	}
	return detail, tx.Commit()
}

// applyFileObservations runs in the same transaction as the tool events.
func applyFileObservations(ctx context.Context, q *sqlitedb.Queries, b *Batch, conv sqlitedb.Conversation) error {
	if len(b.FileObservations) == 0 && len(b.Messages) == 0 && len(b.Attachments) == 0 {
		return nil
	}
	st, err := q.GetResourceState(ctx, conv.ID)
	if errors.Is(err, sql.ErrNoRows) {
		coverage := "complete"
		if conv.TurnCount > 1 || conv.ForkedFromID != "" || conv.ImportedFromSessionID != "" {
			coverage = "partial"
		}
		st = sqlitedb.ConversationResourceState{ConversationID: conv.ID, Coverage: coverage, RecordedFrom: time.Now().UTC().Format(time.RFC3339)}
	} else if err != nil {
		return err
	}
	changed := len(b.Messages) > 0 || len(b.Attachments) > 0
	notify := false
	for _, o := range b.FileObservations {
		n, err := q.HasFileOperation(ctx, sqlitedb.HasFileOperationParams{ConversationID: conv.ID, OperationID: o.OperationID})
		if err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		if err = q.PutFileOperation(ctx, sqlitedb.PutFileOperationParams{ConversationID: conv.ID, OperationID: o.OperationID}); err != nil {
			return err
		}
		changed = true
		if o.Path == "" {
			if o.Reason != "" {
				st.Coverage = "partial"
				st.Reason = o.Reason
			}
			continue
		}
		notify = true
		reason := o.Reason
		// Adapter bytes are bounded and checked again at the persistence boundary.
		if len(o.Before.Content) > filechanges.MaxFileBytes || len(o.After.Content) > filechanges.MaxFileBytes {
			reason = "large_file"
		}
		id := filechanges.Hash(o.Cwd + "\x00" + o.Path + "\x00" + o.OperationID)[:32]
		row, loadErr := q.FindFileChange(ctx, sqlitedb.FindFileChangeParams{ConversationID: conv.ID, Cwd: o.Cwd, Path: o.Path})
		exists := loadErr == nil
		if loadErr != nil && !errors.Is(loadErr, sql.ErrNoRows) {
			return loadErr
		}
		f := FileResource{ID: id, Cwd: o.Cwd, Path: o.Path, InitialExists: o.Before.Exists, TurnID: o.TurnID}
		baseline, latest, patch := o.Before.Content, o.After.Content, ""
		if exists {
			if err = json.Unmarshal([]byte(row.Metadata), &f); err != nil {
				return err
			}
			id = f.ID
			baseline = row.Baseline
			if f.Reason != "" || row.Latest != o.Before.Content || f.CurrentExists != o.Before.Exists {
				reason = "uncertain"
			}
		}
		if reason == "" {
			reason = o.Before.Reason
		}
		if reason == "" {
			reason = o.After.Reason
		}
		f.TurnID = o.TurnID
		if o.MovePath != "" {
			if f.OldPath == "" {
				f.OldPath = f.Path
			}
			f.Path = o.MovePath
			if f.OldPath == f.Path {
				f.OldPath = ""
			}
		}
		f.CurrentExists = o.After.Exists
		f.Kind = "modified"
		if !f.InitialExists && f.CurrentExists {
			f.Kind = "added"
		}
		if !f.CurrentExists {
			f.Kind = "deleted"
		}
		if f.OldPath != "" && f.CurrentExists {
			f.Kind = "renamed"
		}
		f.Reason = reason
		f.Changed = true
		f.Added, f.Deleted = nil, nil
		bytes := int64(len(baseline) + len(latest))
		used, err := q.FileChangeBytes(ctx, conv.ID)
		if err != nil {
			return err
		}
		total, err := q.AllFileChangeBytes(ctx)
		if err != nil {
			return err
		}
		previous := int64(0)
		if exists {
			previous = row.Bytes
		}
		if used.(int64)-previous+bytes > 64<<20 || total.(int64)-previous+bytes > 1<<30 {
			f.Reason = "storage_limit"
		}
		if f.Reason == "" {
			f.Changed = baseline != latest || f.InitialExists != f.CurrentExists || f.OldPath != ""
			oldName := f.Path
			if f.OldPath != "" {
				oldName = f.OldPath
			}
			oldName = "a/" + oldName
			newName := "b/" + f.Path
			if !f.InitialExists {
				oldName = "/dev/null"
			}
			if !f.CurrentExists {
				newName = "/dev/null"
			}
			var ok bool
			patch, ok = cumulativePatch(baseline, latest, oldName, newName)
			if !ok {
				f.Reason = "large_file"
				st.Coverage = "partial"
				st.Reason = f.Reason
				patch = ""
			}
			a, d := 0, 0
			inHunk := false
			for _, line := range strings.Split(patch, "\n") {
				if strings.HasPrefix(line, "@@ ") {
					inHunk = true
					continue
				}
				if !inHunk {
					continue
				}
				if strings.HasPrefix(line, "+") {
					a++
				}
				if strings.HasPrefix(line, "-") {
					d++
				}
			}
			if f.Reason == "" {
				f.Added, f.Deleted = &a, &d
			}
			bytes = int64(len(baseline) + len(latest) + len(patch))
			if used.(int64)-previous+bytes > 64<<20 || total.(int64)-previous+bytes > 1<<30 {
				f.Reason = "storage_limit"
				f.Added, f.Deleted = nil, nil
				st.Coverage = "partial"
				st.Reason = f.Reason
				if exists {
					baseline, latest, patch = row.Baseline, row.Latest, row.Patch
					bytes = row.Bytes
				} else {
					baseline, latest, patch = "", "", ""
					bytes = 0
				}
			}
		} else {
			st.Coverage = "partial"
			st.Reason = f.Reason
			if exists {
				baseline, latest, patch = row.Baseline, row.Latest, row.Patch
			} else {
				baseline, latest = "", ""
			}
			bytes = int64(len(baseline) + len(latest) + len(patch))
		}
		meta, _ := json.Marshal(f)
		if err = q.PutFileChange(ctx, sqlitedb.PutFileChangeParams{ConversationID: conv.ID, ID: id, Cwd: o.Cwd, Path: f.Path, Metadata: string(meta), Baseline: baseline, Latest: latest, Patch: patch, Bytes: bytes}); err != nil {
			return err
		}
	}
	if !changed {
		return nil
	}
	st.Revision++
	if err = q.PutResourceState(ctx, sqlitedb.PutResourceStateParams{ConversationID: conv.ID, Revision: st.Revision, Coverage: st.Coverage, Reason: st.Reason, RecordedFrom: st.RecordedFrom}); err != nil {
		return err
	}
	if !notify {
		return nil
	}
	payload, _ := json.Marshal(map[string]any{"revision": st.Revision})
	b.Events = append(b.Events, NewEvent{Type: "conversation.resources_changed", Payload: payload, CreatedAt: time.Now().UTC()})
	return nil
}
