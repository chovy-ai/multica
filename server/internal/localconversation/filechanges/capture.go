// Package filechanges collects bounded file evidence without changing the workspace.
package filechanges

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const MaxFileBytes = 1 << 20
const MaxScanBytes = 32 << 20
const MaxEntries = 10000

type Snapshot struct {
	Exists  bool   `json:"exists"`
	Content string `json:"content"`
	Hash    string `json:"hash"`
	Reason  string `json:"reason,omitempty"`
}

// Observation is evidence for one file, never an instruction to write it.
type Observation struct {
	OperationID string   `json:"operation_id"`
	Cwd         string   `json:"cwd"`
	Path        string   `json:"path"`
	MovePath    string   `json:"move_path,omitempty"`
	Before      Snapshot `json:"before"`
	After       Snapshot `json:"after"`
	Reason      string   `json:"reason,omitempty"`
	TurnID      string   `json:"turn_id"`
}

func Hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func Excluded(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		switch strings.ToLower(part) {
		case ".git", "node_modules", ".pnpm", ".next", "dist", "build", "vendor", ".cache", ".ssh", ".aws", ".claude", ".codex":
			return true
		}
	}
	name := strings.ToLower(filepath.Base(path))
	return name == ".env" || strings.HasPrefix(name, ".env.") || strings.HasSuffix(name, ".pem") || strings.HasSuffix(name, ".key") || name == "credentials" || name == "credentials.json"
}

// Relative rejects directory escapes and symlinks, including symlink parents.
func Relative(root, path string) (string, string) {
	if !filepath.IsAbs(root) {
		return "", "outside_scope"
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", "read_failed"
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(canonical, path)
	}
	path = filepath.Clean(path)
	rel, err := filepath.Rel(canonical, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "outside_scope"
	}
	if Excluded(rel) {
		return filepath.ToSlash(rel), "excluded"
	}
	current := canonical
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return filepath.ToSlash(rel), "read_failed"
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return filepath.ToSlash(rel), "outside_scope"
		}
	}
	return filepath.ToSlash(rel), ""
}

func Read(root, path string) Snapshot {
	rel, reason := Relative(root, path)
	if reason != "" {
		return Snapshot{Reason: reason}
	}
	f, err := os.Open(filepath.Join(root, filepath.FromSlash(rel)))
	if os.IsNotExist(err) {
		return Snapshot{Hash: Hash("")}
	}
	if err != nil {
		return Snapshot{Reason: "read_failed"}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Snapshot{Reason: "read_failed"}
	}
	if info.Size() > MaxFileBytes {
		return Snapshot{Exists: true, Reason: "large_file"}
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return Snapshot{Exists: true, Reason: "read_failed"}
	}
	if len(b) > MaxFileBytes || strings.Count(string(b), "\n") > 20000 {
		return Snapshot{Exists: true, Reason: "large_file"}
	}
	if !utf8.Valid(b) || strings.IndexByte(string(b), 0) >= 0 {
		return Snapshot{Exists: true, Reason: "binary"}
	}
	after, err := f.Stat()
	if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return Snapshot{Exists: true, Reason: "uncertain"}
	}
	return Snapshot{Exists: true, Content: string(b), Hash: Hash(string(b))}
}

type Capture struct {
	mu       sync.Mutex
	Root     string
	Files    map[string]Snapshot
	Complete bool
	touched  map[string]bool
}

func Scan(root string) *Capture {
	c := &Capture{Root: root, Files: map[string]Snapshot{}, touched: map[string]bool{}}
	if !filepath.IsAbs(root) {
		return c
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return c
	}
	c.Root = canonical
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// Git is used only for its ignore-aware directory listing, never as a diff baseline.
	cmd := exec.CommandContext(ctx, "git", "-C", canonical, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".")
	stdout, pipeErr := cmd.StdoutPipe()
	var raw []byte
	gitErr := pipeErr
	if gitErr == nil {
		gitErr = cmd.Start()
	}
	truncated := false
	if gitErr == nil {
		raw, gitErr = io.ReadAll(io.LimitReader(stdout, MaxScanBytes+1))
		if len(raw) > MaxScanBytes {
			truncated = true
			cancel()
		}
		waitErr := cmd.Wait()
		if gitErr == nil {
			gitErr = waitErr
		}
	}
	if truncated {
		return c
	}
	var paths []string
	if gitErr == nil {
		paths = strings.Split(string(raw), "\x00")
	} else {
		err = filepath.WalkDir(canonical, func(path string, entry fs.DirEntry, err error) error {
			if ctx.Err() != nil || len(paths) > MaxEntries {
				return fs.SkipAll
			}
			if err != nil {
				return err
			}
			if path == canonical {
				return nil
			}
			rel, _ := filepath.Rel(canonical, path)
			if Excluded(rel) {
				if entry.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if entry.Type().IsRegular() {
				paths = append(paths, rel)
			}
			return nil
		})
	}
	sort.Strings(paths)
	total, count := 0, 0
	c.Complete = err == nil && ctx.Err() == nil && len(paths) <= MaxEntries
	for _, path := range paths {
		if path == "" {
			continue
		}
		if ctx.Err() != nil || count >= MaxEntries {
			c.Complete = false
			break
		}
		count++
		rel, reason := Relative(canonical, path)
		if reason != "" {
			continue
		}
		snap := Read(canonical, rel)
		total += len(snap.Content)
		if total > MaxScanBytes {
			c.Complete = false
			break
		}
		c.Files[rel] = snap
	}
	return c
}

func (c *Capture) Before(path string) Snapshot {
	if s, ok := c.Files[path]; ok {
		return s
	}
	if c.Complete {
		return Snapshot{Hash: Hash("")}
	}
	return Snapshot{Reason: "missing_baseline"}
}

// Codex checks the native patch against both versions; success status alone is insufficient.
func (c *Capture) Codex(operation, turn, path, move, kind, patch string, success bool) Observation {
	c.mu.Lock()
	defer c.mu.Unlock()
	rel, reason := Relative(c.Root, path)
	o := Observation{OperationID: operation, TurnID: turn, Cwd: c.Root, Path: rel, Reason: reason}
	if reason != "" {
		return o
	}
	target := rel
	if move != "" {
		target, o.Reason = Relative(c.Root, move)
		o.MovePath = target
	}
	o.Before, o.After = c.Before(rel), Read(c.Root, target)
	if o.Reason == "" {
		o.Reason = o.Before.Reason
	}
	if o.Reason == "" {
		o.Reason = o.After.Reason
	}
	if o.Reason == "" && o.Before.Hash == o.After.Hash && o.Before.Exists == o.After.Exists && move == "" {
		o.Path = ""
		return o
	}
	if o.Reason == "" && move != "" && rel != target && Read(c.Root, rel).Exists {
		o.Reason = "uncertain"
	}
	if o.Reason == "" {
		expected, ok := Apply(o.Before.Content, patch, kind)
		if !success || !ok || expected != o.After.Content || (kind == "delete" && o.After.Exists) || (kind != "delete" && !o.After.Exists) {
			o.Reason = "uncertain"
		}
	}
	c.touched[rel], c.touched[target] = true, true
	if o.Reason == "" {
		delete(c.Files, rel)
		c.Files[target] = o.After
	}
	return o
}

// Unknown discovers changes a shell or background writer did not identify with native evidence.
func (c *Capture) Unknown(turn string) []Observation {
	c.mu.Lock()
	defer c.mu.Unlock()
	after := Scan(c.Root)
	paths := map[string]bool{}
	for path := range c.Files {
		paths[path] = true
	}
	for path := range after.Files {
		paths[path] = true
	}
	var out []Observation
	for path := range paths {

		a, b := c.Before(path), after.Before(path)
		if a.Hash == b.Hash && a.Exists == b.Exists && a.Reason == b.Reason {
			continue
		}
		out = append(out, Observation{OperationID: turn + ":unknown:" + path, TurnID: turn, Cwd: c.Root, Path: path, Before: a, After: b, Reason: "uncertain"})
	}
	return out
}

func (c *Capture) Recorded(o Observation) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if o.Reason == "" {
		c.Files[o.Path] = o.After
	}
}
