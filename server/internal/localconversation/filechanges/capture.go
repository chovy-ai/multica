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
	mu        sync.Mutex
	Root      string
	Files     map[string]Snapshot
	Complete  bool
	touched   map[string]bool
	unsampled map[string]struct{}
}

func gitPaths(ctx context.Context, root string, args ...string) ([]byte, bool, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root, "ls-files"}, args...)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	if err = cmd.Start(); err != nil {
		return nil, false, err
	}
	raw, readErr := io.ReadAll(io.LimitReader(stdout, MaxScanBytes+1))
	truncated := len(raw) > MaxScanBytes
	if truncated || readErr != nil {
		cancel()
	}
	err = cmd.Wait()
	if readErr != nil {
		err = readErr
	}
	return raw, truncated, err
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
	raw, truncated, gitErr := gitPaths(ctx, canonical, "--cached", "--others", "--exclude-standard", "-z", "--", ".")
	if truncated {
		return c
	}
	var paths []string
	listingComplete := true
	metadataBytes := len(raw)
	if gitErr == nil {
		paths = strings.Split(string(raw), "\x00")
		// Retain ignored names, not contents. Directory entries cover their
		// descendants without walking dependency/build trees or reading secrets.
		ignored, limited, ignoredErr := gitPaths(ctx, canonical, "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", ".")
		listingComplete = ignoredErr == nil && !limited
		metadataBytes += len(ignored)
		c.unsampled = map[string]struct{}{}
		if listingComplete {
			for _, path := range strings.Split(string(ignored), "\x00") {
				if path == "" {
					continue
				}
				if len(c.unsampled) >= MaxEntries {
					listingComplete = false
					break
				}
				c.unsampled[path] = struct{}{}
			}
		}
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
	total, count := metadataBytes, 0
	c.Complete = listingComplete && err == nil && ctx.Err() == nil && len(paths)+len(c.unsampled) <= MaxEntries && total <= MaxScanBytes
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
	return c.before(c.Files, path)
}

func (c *Capture) before(files map[string]Snapshot, path string) Snapshot {
	if s, ok := files[path]; ok {
		return s
	}
	if _, ok := c.unsampled[path]; ok {
		return Snapshot{Reason: "excluded"}
	}
	for parent := path; strings.Contains(parent, "/"); {
		parent = parent[:strings.LastIndex(parent, "/")]
		if _, ok := c.unsampled[parent+"/"]; ok {
			return Snapshot{Reason: "excluded"}
		}
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
	o.Before = c.Before(rel)
	if o.Before.Reason == "excluded" || c.Before(target).Reason == "excluded" {
		o.MovePath, o.Reason = "", "excluded"
		o.After = Read(c.Root, rel)
		return o
	}
	o.After = Read(c.Root, target)
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
	deadline := time.Now().Add(2 * time.Second)
	after := Scan(c.Root)
	readBytes := 0
	for path, snapshot := range after.Files {
		readBytes += len(path) + len(snapshot.Content)
	}
	for path := range after.unsampled {
		readBytes += len(path)
	}
	paths := map[string]bool{}
	for path := range c.Files {
		paths[path] = true
	}
	for path := range after.Files {
		paths[path] = true
	}
	var out []Observation
	if !after.Complete {
		out = append(out, Observation{OperationID: turn + ":unknown:scan-limit", TurnID: turn, Reason: "scan_limit"})
	}
	for path := range paths {

		a := c.Before(path)
		if a.Reason == "excluded" {
			out = append(out, Observation{OperationID: turn + ":unknown:" + path, TurnID: turn, Cwd: c.Root, Path: path, Before: a, After: after.Files[path], Reason: "excluded"})
			continue
		}
		b, ok := after.Files[path]
		if !ok {
			// A filtered or incomplete listing cannot prove deletion. Known
			// paths still use the same bounded, scope-checked file reader.
			if time.Now().Before(deadline) && readBytes < MaxScanBytes {
				b = Read(c.Root, path)
				readBytes += len(b.Content)
			}
			if b == (Snapshot{}) || readBytes > MaxScanBytes {
				b = Snapshot{Exists: a.Exists, Reason: "scan_limit"}
			}
			if b.Reason != "" && !b.Exists {
				b.Exists = a.Exists
			}
		}
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
