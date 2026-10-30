package localhost

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// listDirectories lists the folders in path, or in the home folder when path
// is empty, for choosing a folder on a device without its OS picker. It
// only names folders; reading files still goes through the preview routes.
func listDirectories(w http.ResponseWriter, path string) {
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			writeV2Error(w, err)
			return
		}
		path = home
	}
	if !filepath.IsAbs(path) {
		writeV2Error(w, AppError("invalid_request", "path must be absolute"))
		return
	}
	path = filepath.Clean(path)
	entries, err := os.ReadDir(path)
	if err != nil {
		writeV2Error(w, AppError("not_found", "This folder cannot be read"))
		return
	}
	dirs := []map[string]string{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		full := filepath.Join(path, e.Name())
		if e.Type()&os.ModeSymlink != 0 {
			if info, err := os.Stat(full); err != nil || !info.IsDir() {
				continue
			}
		} else if !e.IsDir() {
			continue
		}
		dirs = append(dirs, map[string]string{"name": e.Name(), "path": full})
	}
	sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i]["name"]) < strings.ToLower(dirs[j]["name"]) })
	parent := filepath.Dir(path)
	if parent == path {
		parent = ""
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "parent": parent, "entries": dirs})
}
