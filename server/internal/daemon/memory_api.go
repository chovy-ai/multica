package daemon

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/agentmemory"
	"github.com/multica-ai/multica/server/internal/daemon/localhost"
)

func memoryJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func memoryError(w http.ResponseWriter, status int, kind, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"kind": kind, "message": message}})
}
func memoryStoreError(w http.ResponseWriter, err error) {
	status, kind := 500, "internal"
	for _, v := range []struct {
		err    error
		status int
		kind   string
	}{{agentmemory.ErrInvalidPath, 400, "invalid_path"}, {agentmemory.ErrInvalidInput, 400, "invalid_request"}, {agentmemory.ErrNotFound, 404, "not_found"}, {agentmemory.ErrAlreadyExists, 409, "already_exists"}, {agentmemory.ErrConflict, 409, "conflict"}, {agentmemory.ErrTooLarge, 413, "too_large"}, {agentmemory.ErrRestoreTargetExists, 409, "restore_target_exists"}} {
		if errors.Is(err, v.err) {
			status, kind = v.status, v.kind
			break
		}
	}
	message := err.Error()
	if status == 500 {
		message = "could not access agent memory"
	}
	memoryError(w, status, kind, message)
}
func memoryDecode(w http.ResponseWriter, r *http.Request, v any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	err := decoder.Decode(v)
	if err == nil {
		var extra any
		if end := decoder.Decode(&extra); end != io.EOF {
			err = agentmemory.ErrInvalidInput
		}
	}
	if err == nil {
		return true
	}
	var max *http.MaxBytesError
	if errors.As(err, &max) {
		memoryError(w, 413, "too_large", "request exceeds 64KB")
	} else {
		memoryError(w, 400, "invalid_request", "invalid request body")
	}
	return false
}
func (d *Daemon) registerMemoryRoutes(mux *http.ServeMux, desktop bool) {
	mux.HandleFunc("/memory/", d.memoryTaskHandler)
	if desktop {
		mux.HandleFunc("/local/agents/{id}/memory", d.memoryDesktopHandler)
		mux.HandleFunc("/local/agents/{id}/memory/{operation}", d.memoryDesktopHandler)
	}
}
func (d *Daemon) memoryTaskHandler(w http.ResponseWriter, r *http.Request) {
	task, auth := d.activeRepoCheckoutTask(r)
	if auth != repoCheckoutAuthOK {
		if auth == repoCheckoutAuthNoCredential {
			memoryError(w, 401, "no_credential", "missing task credential")
		} else {
			memoryError(w, 401, "unknown_credential", "task credential is unknown; the task may have ended")
		}
		return
	}
	if r.URL.Path == "/memory/receipts/claim" && r.Method == http.MethodPost {
		titles, err := agentmemory.ClaimReceipts(task.EnvRoot)
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		memoryJSON(w, map[string]any{"titles": titles})
		return
	}
	d.memoryRequest(w, r, task.AgentID, strings.TrimPrefix(r.URL.Path, "/memory/"), &task)
}
func (d *Daemon) memoryDesktopHandler(w http.ResponseWriter, r *http.Request) {
	if !localhost.AuthorizeDesktop(r, d.cfg.LocalAPIToken) {
		memoryError(w, 403, "forbidden", "desktop authorization required")
		return
	}
	d.memoryRequest(w, r, r.PathValue("id"), r.PathValue("operation"), nil)
}
func (d *Daemon) expandMemoryPath(id, path string, task *activeRepoCheckoutTask) (string, error) {
	if task != nil && strings.HasPrefix(path, "project/") && len(strings.Split(path, "/")) == 2 {
		folder, err := d.memory.ResolveProjectDir(id, agentmemory.ProjectRef{ID: task.ProjectID, Title: task.ProjectTitle})
		if err != nil {
			return "", err
		}
		path = "project/" + folder + "/" + strings.TrimPrefix(path, "project/")
	}
	return agentmemory.NormalizePath(path)
}
func (d *Daemon) memoryRequest(w http.ResponseWriter, r *http.Request, id, op string, task *activeRepoCheckoutTask) {
	if _, err := d.memory.Root(id); err != nil {
		memoryStoreError(w, err)
		return
	}
	switch {
	case task == nil && op == "" && r.Method == http.MethodGet:
		exists, err := d.memory.Exists(id)
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		root, _ := d.memory.Root(id)
		index := ""
		entries := []agentmemory.Entry{}
		projects := []agentmemory.Project{}
		trash := []agentmemory.TrashItem{}
		if exists {
			index, err = d.memory.Index(id)
			if err == nil {
				entries, err = d.memory.List(id)
			}
			if err == nil {
				projects, err = d.memory.Projects(id)
			}
			if err == nil {
				trash, err = d.memory.Trash(id)
			}
		}
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		memoryJSON(w, map[string]any{"exists": exists, "root": root, "index": index, "entries": entries, "projects": projects, "trash": trash})
	case task == nil && op == "" && r.Method == http.MethodDelete:
		if err := d.memory.Clear(id); err != nil {
			memoryStoreError(w, err)
			return
		}
		memoryJSON(w, map[string]any{})
	case task != nil && op == "index" && r.Method == http.MethodGet:
		var text string
		var err error
		if r.URL.Query().Get("all") == "1" {
			text, err = d.memory.Index(id)
		} else {
			var dir string
			dir, err = d.memory.ResolveProjectDir(id, agentmemory.ProjectRef{ID: task.ProjectID, Title: task.ProjectTitle})
			if err == nil {
				var snap agentmemory.Snapshot
				snap, err = d.memory.Snapshot(id, dir)
				text = snap.Text
			}
		}
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		memoryJSON(w, map[string]string{"text": text})
	case op == "entry" && r.Method == http.MethodGet:
		// Trash reads use the same endpoint so the desktop can preview before restoring.
		var entry agentmemory.Entry
		var err error
		if task == nil && r.URL.Query().Get("trash_path") != "" {
			entry, err = d.memory.ReadTrash(id, r.URL.Query().Get("trash_path"))
		} else {
			var path string
			path, err = d.expandMemoryPath(id, r.URL.Query().Get("path"), task)
			if err == nil {
				entry, err = d.memory.Read(id, path)
			}
		}
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		memoryJSON(w, map[string]any{"entry": entry})
	case op == "entry" && r.Method == http.MethodPut:
		var in struct {
			Path              string                `json:"path"`
			Title             string                `json:"title"`
			Description       string                `json:"description"`
			Body              string                `json:"body"`
			Mode              agentmemory.WriteMode `json:"mode"`
			ExpectedUpdatedAt *time.Time            `json:"expected_updated_at"`
		}
		if !memoryDecode(w, r, &in) {
			return
		}
		path, err := d.expandMemoryPath(id, in.Path, task)
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		input := agentmemory.WriteInput{Path: path, Title: in.Title, Description: in.Description, Body: in.Body, Mode: in.Mode, ExpectedUpdatedAt: in.ExpectedUpdatedAt}
		if task == nil {
			if in.ExpectedUpdatedAt == nil {
				memoryStoreError(w, agentmemory.ErrInvalidInput)
				return
			}
			input.Mode = "update"
		} else {
			input.ExpectedUpdatedAt = nil
			input.Source = task.Source
			input.Project = agentmemory.ProjectRef{ID: task.ProjectID, Title: task.ProjectTitle}
		}
		entry, warnings, err := d.memory.Write(id, input)
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		if task != nil {
			if err = agentmemory.RecordReceipt(task.EnvRoot, entry.Path, entry.Title); err != nil {
				d.logger.Warn("memory receipt registration failed", "error", err)
			}
			entry.Body = ""
		}
		memoryJSON(w, map[string]any{"entry": entry, "warnings": warnings})
	case op == "entry" && r.Method == http.MethodDelete:
		path, err := d.expandMemoryPath(id, r.URL.Query().Get("path"), task)
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		trash, err := d.memory.Delete(id, path)
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		memoryJSON(w, map[string]string{"trash_path": trash})
	case op == "search" && r.Method == http.MethodGet:
		limit := 10
		if v := r.URL.Query().Get("limit"); v != "" {
			var err error
			limit, err = strconv.Atoi(v)
			if err != nil {
				memoryStoreError(w, agentmemory.ErrInvalidInput)
				return
			}
		}
		hits, err := d.memory.Search(id, r.URL.Query().Get("q"), limit)
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		memoryJSON(w, map[string]any{"hits": hits})
	case task == nil && op == "restore" && r.Method == http.MethodPost:
		var in struct {
			TrashPath string `json:"trash_path"`
		}
		if !memoryDecode(w, r, &in) {
			return
		}
		entry, err := d.memory.Restore(id, in.TrashPath)
		if err != nil {
			memoryStoreError(w, err)
			return
		}
		memoryJSON(w, map[string]any{"entry": entry})
	default:
		memoryError(w, 405, "invalid_request", "unsupported memory operation")
	}
}
