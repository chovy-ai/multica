package agentmemory

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const trashTimeFormat = "20060102T150405Z"

func trashTime(name string) (time.Time, error) {
	return time.Parse(trashTimeFormat, strings.Split(name, "-")[0])
}
func (m *Manager) trashTarget(root, path string) (string, string, error) {
	stamp := time.Now().UTC().Format(trashTimeFormat)
	for i := 0; ; i++ {
		dir := stamp
		if i > 0 {
			dir = fmt.Sprintf("%s-%d", stamp, i)
		}
		rel := dir + "/" + path
		target, err := safePath(root, ".trash/"+rel)
		if err != nil {
			return "", "", err
		}
		if _, err = os.Lstat(target); errors.Is(err, os.ErrNotExist) {
			return rel, target, nil
		} else if err != nil {
			return "", "", err
		}
	}
}
func (m *Manager) Delete(id, path string) (string, error) {
	defer m.lock(id)()
	path, err := NormalizePath(path)
	if err != nil {
		return "", err
	}
	if _, err = m.Read(id, path); err != nil {
		return "", err
	}
	root, err := m.Root(id)
	if err != nil {
		return "", err
	}
	target, err := safePath(root, path)
	if err != nil {
		return "", err
	}
	rel, dest, err := m.trashTarget(root, path)
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return "", err
	}
	if err = os.Rename(target, dest); err != nil {
		return "", err
	}
	return rel, m.refresh(id)
}
func (m *Manager) Trash(id string) ([]TrashItem, error) {
	root, err := m.Root(id)
	if err != nil {
		return nil, err
	}
	dir, err := safePath(root, ".trash")
	if err != nil {
		return nil, err
	}
	items := []TrashItem{}
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
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		parts := strings.SplitN(filepath.ToSlash(rel), "/", 2)
		if len(parts) != 2 {
			return nil
		}
		when, err := trashTime(parts[0])
		if err != nil {
			return nil
		}
		if _, err = NormalizePath(parts[1]); err != nil {
			return nil
		}
		title := ""
		data, err := os.ReadFile(path)
		if err == nil {
			e, err := ParseEntry(parts[1], data)
			if err == nil {
				title = e.Title
			}
		}
		items = append(items, TrashItem{filepath.ToSlash(rel), parts[1], title, when})
		return nil
	})
	sort.Slice(items, func(i, j int) bool {
		if items[i].DeletedAt.Equal(items[j].DeletedAt) {
			return items[i].TrashPath < items[j].TrashPath
		}
		return items[i].DeletedAt.After(items[j].DeletedAt)
	})
	return items, err
}
func (m *Manager) ReadTrash(id, rel string) (Entry, error) {
	parts := strings.SplitN(rel, "/", 2)
	if len(parts) != 2 {
		return Entry{}, ErrInvalidPath
	}
	if _, err := trashTime(parts[0]); err != nil {
		return Entry{}, ErrInvalidPath
	}
	if _, err := NormalizePath(parts[1]); err != nil {
		return Entry{}, err
	}
	root, err := m.Root(id)
	if err != nil {
		return Entry{}, err
	}
	path, err := safePath(root, ".trash/"+rel)
	if err != nil {
		return Entry{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Entry{}, ErrNotFound
	}
	if err != nil {
		return Entry{}, err
	}
	return ParseEntry(parts[1], data)
}
func (m *Manager) Restore(id, rel string) (Entry, error) {
	defer m.lock(id)()
	e, err := m.ReadTrash(id, rel)
	if err != nil {
		return Entry{}, err
	}
	root, err := m.Root(id)
	if err != nil {
		return Entry{}, err
	}
	target, err := safePath(root, e.Path)
	if err != nil {
		return Entry{}, err
	}
	if _, err = os.Lstat(target); err == nil {
		return Entry{}, ErrRestoreTargetExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return Entry{}, err
	}
	source, err := safePath(root, ".trash/"+rel)
	if err != nil {
		return Entry{}, err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return Entry{}, err
	}
	if err = os.Rename(source, target); err != nil {
		return Entry{}, err
	}
	for dir := filepath.Dir(source); dir != filepath.Join(root, ".trash"); dir = filepath.Dir(dir) {
		if os.Remove(dir) != nil {
			break
		}
	}
	return e, m.refresh(id)
}
func (m *Manager) Clear(id string) error {
	defer m.lock(id)()
	root, err := m.Root(id)
	if err != nil {
		return err
	}
	_, dest, err := m.trashTarget(root, "feedback")
	if err != nil {
		return err
	}
	trashRoot := filepath.Dir(dest)
	// Reserve a fresh batch even when the first category is absent.
	for i := 0; ; i++ {
		candidate := trashRoot
		if i > 0 {
			candidate = fmt.Sprintf("%s-%d", trashRoot, i)
		}
		err = os.MkdirAll(filepath.Dir(candidate), 0700)
		if err != nil {
			return err
		}
		err = os.Mkdir(candidate, 0700)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		trashRoot = candidate
		break
	}
	for _, kind := range []string{"feedback", "project", "reference"} {
		source, err := safePath(root, kind)
		if err != nil {
			return err
		}
		if _, err = os.Stat(source); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		if err = os.Rename(source, filepath.Join(trashRoot, kind)); err != nil {
			return err
		}
	}
	for _, rel := range []string{"MEMORY.md", ".multica/index.db"} {
		path, err := safePath(root, rel)
		if err != nil {
			return err
		}
		if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
func PruneTrash(profileDir string, retention time.Duration, now time.Time) (int, error) {
	agents, err := os.ReadDir(filepath.Join(profileDir, "agents"))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	m := NewManager(profileDir)
	for _, agent := range agents {
		if !agent.IsDir() || !agentPattern.MatchString(agent.Name()) {
			continue
		}
		root, err := m.Root(agent.Name())
		if err != nil {
			return removed, err
		}
		dir, err := safePath(root, ".trash")
		if err != nil {
			return removed, err
		}
		items, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return removed, err
		}
		for _, item := range items {
			if !item.IsDir() {
				continue
			}
			when, err := trashTime(item.Name())
			if err != nil || !when.Before(now.Add(-retention)) {
				continue
			}
			target, err := safePath(dir, item.Name())
			if err != nil {
				return removed, err
			}
			if err = os.RemoveAll(target); err != nil {
				return removed, err
			}
			removed++
		}
	}
	return removed, nil
}
