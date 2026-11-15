package claude

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// applyToolResult retains the structured provider output independently of the
// model-visible text. Only this adapter interprets Claude's per-tool shapes.
func applyToolResult(state map[string]any, raw json.RawMessage) {
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil || result == nil {
		return
	}
	state["result"] = result
	var changes []any
	incomplete := false
	if diff, ok := result["bashEditDiff"].(map[string]any); ok {
		seen := map[string]bool{}
		files, _ := diff["files"].([]any)
		for _, value := range files {
			file, _ := value.(map[string]any)
			path, _ := file["filePath"].(string)
			if path == "" {
				continue
			}
			change := map[string]any{"path": path, "kind": "update"}
			if patch := hunkPatch(file["hunks"]); patch != "" {
				change["diff"] = patch
			} else {
				incomplete = true
			}
			changes = append(changes, change)
			seen[path] = true
		}
		paths, _ := diff["changedFiles"].([]any)
		for _, value := range paths {
			if path, ok := value.(string); ok && path != "" && !seen[path] {
				changes = append(changes, map[string]any{"path": path, "kind": "update"})
				seen[path] = true
				incomplete = true
			}
		}
		if more, _ := diff["moreFiles"].(float64); more > 0 {
			incomplete = true
		}
	} else if path, ok := result["filePath"].(string); ok && path != "" {
		if patch := hunkPatch(result["structuredPatch"]); patch != "" {
			changes = append(changes, map[string]any{"path": path, "kind": "update", "diff": patch})
		}
	}
	if len(changes) > 0 {
		state["file_changes"] = changes
	}
	if incomplete {
		state["file_changes_incomplete"] = true
	}
}

func hunkPatch(raw any) string {
	hunks, _ := raw.([]any)
	var patch strings.Builder
	for _, value := range hunks {
		h, _ := value.(map[string]any)
		oldStart, a := h["oldStart"].(float64)
		oldLines, b := h["oldLines"].(float64)
		newStart, c := h["newStart"].(float64)
		newLines, d := h["newLines"].(float64)
		lines, e := h["lines"].([]any)
		if !a || !b || !c || !d || !e || oldStart < 0 || oldLines < 0 || newStart < 0 || newLines < 0 || math.Trunc(oldStart) != oldStart || math.Trunc(oldLines) != oldLines || math.Trunc(newStart) != newStart || math.Trunc(newLines) != newLines {
			return ""
		}
		fmt.Fprintf(&patch, "@@ -%d,%d +%d,%d @@\n", int(oldStart), int(oldLines), int(newStart), int(newLines))
		for _, value := range lines {
			line, ok := value.(string)
			if !ok || len(line) == 0 {
				return ""
			}
			patch.WriteString(line)
			patch.WriteByte('\n')
		}
	}
	return patch.String()
}
