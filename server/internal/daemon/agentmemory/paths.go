package agentmemory

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	ErrInvalidPath         = errors.New("invalid memory path")
	ErrInvalidInput        = errors.New("invalid memory input")
	ErrNotFound            = errors.New("memory entry not found")
	ErrAlreadyExists       = errors.New("memory entry already exists")
	ErrConflict            = errors.New("memory entry changed; reload before saving")
	ErrTooLarge            = errors.New("memory body exceeds 8KB")
	ErrRestoreTargetExists = errors.New("restore target already exists")
	agentPattern           = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	slugPattern            = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	folderPattern          = regexp.MustCompile(`^[a-z0-9-]{1,11}-[0-9a-f]{12}$`)
	nonSlug                = regexp.MustCompile(`[^a-z0-9]+`)
)

func NormalizePath(path string) (string, error) {
	if strings.ContainsAny(path, `\`) || strings.Contains(path, "..") {
		return "", ErrInvalidPath
	}
	parts := strings.Split(path, "/")
	if len(parts) != 2 && len(parts) != 3 {
		return "", ErrInvalidPath
	}
	name := strings.TrimSuffix(parts[len(parts)-1], ".md")
	if !slugPattern.MatchString(name) {
		return "", ErrInvalidPath
	}
	switch parts[0] {
	case "feedback", "reference":
		if len(parts) != 2 {
			return "", ErrInvalidPath
		}
	case "project":
		if len(parts) != 3 || (parts[1] != "general" && !folderPattern.MatchString(parts[1])) {
			return "", ErrInvalidPath
		}
	default:
		return "", ErrInvalidPath
	}
	parts[len(parts)-1] = name + ".md"
	return strings.Join(parts, "/"), nil
}

// safePath rejects links in every existing component, including internal metadata.
// All mutations are serialized by the manager; files remain private to the OS user.
func safePath(base, rel string) (string, error) {
	if filepath.IsAbs(rel) || strings.Contains(rel, "..") || strings.Contains(rel, `\`) {
		return "", ErrInvalidPath
	}
	current := base
	if info, err := os.Lstat(current); err == nil && (info.Mode()&os.ModeSymlink != 0 || !info.IsDir()) {
		return "", ErrInvalidPath
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." {
			return "", ErrInvalidPath
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", ErrInvalidPath
		}
	}
	return current, nil
}

func (m *Manager) Root(agentID string) (string, error) {
	if !agentPattern.MatchString(agentID) {
		return "", ErrInvalidPath
	}
	return safePath(m.profileDir, "agents/"+agentID+"/memory")
}

func (m *Manager) ResolveProjectDir(agentID string, p ProjectRef) (string, error) {
	root, err := m.Root(agentID)
	if err != nil {
		return "", err
	}
	if p.ID == "" {
		return "general", nil
	}
	if !agentPattern.MatchString(p.ID) {
		return "", ErrInvalidInput
	}
	id := strings.ReplaceAll(p.ID, "-", "")
	suffix := id[len(id)-12:]
	dir, err := safePath(root, "project")
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	for _, e := range entries {
		if e.IsDir() && folderPattern.MatchString(e.Name()) && strings.HasSuffix(e.Name(), "-"+suffix) {
			return e.Name(), nil
		}
	}
	prefix := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(p.Title), "-"), "-")
	if len(prefix) > 11 {
		prefix = strings.TrimRight(prefix[:11], "-")
	}
	if prefix == "" {
		prefix = "project"
	}
	return prefix + "-" + suffix, nil
}
