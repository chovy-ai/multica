package agentmemory

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Manager struct {
	profileDir string
	locks      sync.Map
}

func NewManager(profileDir string) *Manager { return &Manager{profileDir: profileDir} }
func (m *Manager) Close() error             { return nil }
func (m *Manager) lock(agentID string) func() {
	v, _ := m.locks.LoadOrStore(agentID, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func AtomicWrite(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".memory-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, path)
}
func (m *Manager) Exists(id string) (bool, error) {
	root, err := m.Root(id)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(root)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
func (m *Manager) Read(id, path string) (Entry, error) {
	path, err := NormalizePath(path)
	if err != nil {
		return Entry{}, err
	}
	root, err := m.Root(id)
	if err != nil {
		return Entry{}, err
	}
	target, err := safePath(root, path)
	if err != nil {
		return Entry{}, err
	}
	data, err := os.ReadFile(target)
	if errors.Is(err, os.ErrNotExist) {
		return Entry{}, ErrNotFound
	}
	if err != nil {
		return Entry{}, err
	}
	return ParseEntry(path, data)
}
func (m *Manager) entries(id string) ([]Entry, error) {
	root, err := m.Root(id)
	if err != nil {
		return nil, err
	}
	result := []Entry{}
	for _, kind := range []string{"feedback", "project", "reference"} {
		dir, err := safePath(root, kind)
		if err != nil {
			return nil, err
		}
		err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if d.Type()&os.ModeSymlink != 0 {
				return ErrInvalidPath
			}
			if d.IsDir() || strings.HasPrefix(d.Name(), ".") {
				return nil
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			e, err := m.Read(id, filepath.ToSlash(rel))
			if err != nil {
				return err
			}
			result = append(result, e)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	return result, nil
}
func (m *Manager) List(id string) ([]Entry, error) {
	entries, err := m.entries(id)
	for i := range entries {
		entries[i].Body = ""
	}
	return entries, err
}
func (m *Manager) Write(id string, in WriteInput) (Entry, []Warning, error) {
	defer m.lock(id)()
	in.Title = strings.TrimSpace(in.Title)
	in.Description = strings.TrimSpace(in.Description)
	if err := validate(in); err != nil {
		return Entry{}, nil, err
	}
	path, err := NormalizePath(in.Path)
	if err != nil {
		return Entry{}, nil, err
	}
	root, err := m.Root(id)
	if err != nil {
		return Entry{}, nil, err
	}
	target, err := safePath(root, path)
	if err != nil {
		return Entry{}, nil, err
	}
	old, readErr := m.Read(id, path)
	if readErr != nil && !errors.Is(readErr, ErrNotFound) {
		return Entry{}, nil, readErr
	}
	if in.Mode == "create" && readErr == nil {
		return Entry{}, nil, ErrAlreadyExists
	}
	if in.Mode == "update" && readErr != nil {
		return Entry{}, nil, ErrNotFound
	}
	if in.ExpectedUpdatedAt != nil && !old.UpdatedAt.Equal(*in.ExpectedUpdatedAt) {
		return Entry{}, nil, ErrConflict
	}
	now := time.Now().UTC().Truncate(time.Second)
	// Second-resolution versions must still change on rapid consecutive edits.
	if !old.UpdatedAt.IsZero() && !now.After(old.UpdatedAt) {
		now = old.UpdatedAt.Add(time.Second)
	}
	e := Entry{Path: path, Kind: Kind(strings.Split(path, "/")[0]), Title: in.Title, Description: in.Description, Body: in.Body, Source: in.Source, CreatedAt: now, UpdatedAt: now}
	if e.Kind == "project" {
		e.ProjectDir = strings.Split(path, "/")[1]
	}
	if readErr == nil {
		e.CreatedAt = old.CreatedAt
		e.extra = old.extra
		if in.ExpectedUpdatedAt != nil {
			e.Source = old.Source
		}
	}
	data, err := FormatEntry(e)
	if err != nil {
		return Entry{}, nil, err
	}
	if err = AtomicWrite(target, data); err != nil {
		return Entry{}, nil, err
	}
	if e.Kind == "project" && in.Project.ID != "" {
		folder, err := m.ResolveProjectDir(id, in.Project)
		if err != nil {
			return Entry{}, nil, err
		}
		if folder == e.ProjectDir {
			meta, err := safePath(root, "project/"+folder+"/.project.json")
			if err != nil {
				return Entry{}, nil, err
			}
			data, _ := json.Marshal(map[string]string{"project_id": in.Project.ID, "title": in.Project.Title})
			if err = AtomicWrite(meta, data); err != nil {
				return Entry{}, nil, err
			}
		}
	}
	if err = m.refresh(id); err != nil {
		return Entry{}, nil, err
	}
	warnings := []Warning{}
	if len(in.Body) > 2048 {
		warnings = append(warnings, "body_over_soft_limit")
	}
	return e, warnings, nil
}
func (m *Manager) Projects(id string) ([]Project, error) {
	entries, err := m.List(id)
	if err != nil {
		return nil, err
	}
	root, err := m.Root(id)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	projects := []Project{}
	for _, e := range entries {
		if e.ProjectDir == "" || seen[e.ProjectDir] {
			continue
		}
		seen[e.ProjectDir] = true
		title := e.ProjectDir
		path, err := safePath(root, "project/"+e.ProjectDir+"/.project.json")
		if err != nil {
			return nil, err
		}
		data, err := os.ReadFile(path)
		if err == nil {
			var meta struct {
				Title string `json:"title"`
			}
			if json.Unmarshal(data, &meta) == nil && meta.Title != "" {
				title = meta.Title
			}
		}
		projects = append(projects, Project{e.ProjectDir, title})
	}
	return projects, nil
}
