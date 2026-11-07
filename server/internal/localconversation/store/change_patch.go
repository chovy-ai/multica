package store

import (
	"fmt"
	"github.com/hexops/gotextdiff"
	"github.com/hexops/gotextdiff/myers"
	"github.com/hexops/gotextdiff/span"
	"strings"
)

// cumulativePatch bounds Myers to the changed middle; large unrelated rewrites
// remain unavailable instead of holding the single SQLite writer without bound.
func cumulativePatch(before, after, oldName, newName string) (string, bool) {
	if before == after {
		return "", true
	}
	split := func(s string) []string {
		if s == "" {
			return nil
		}
		l := strings.SplitAfter(s, "\n")
		if l[len(l)-1] == "" {
			l = l[:len(l)-1]
		}
		return l
	}
	a, b := split(before), split(after)
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	endA, endB := len(a), len(b)
	for endA > prefix && endB > prefix && a[endA-1] == b[endB-1] {
		endA--
		endB--
	}
	uri := span.URIFromPath(newName)
	var edits []gotextdiff.TextEdit
	if endA == prefix || endB == prefix {
		edits = []gotextdiff.TextEdit{{Span: span.New(uri, span.NewPoint(prefix+1, 1, 0), span.NewPoint(endA+1, 1, 0)), NewText: strings.Join(b[prefix:endB], "")}}
	} else {
		n, m := endA-prefix, endB-prefix
		if n+m > 4000 || n*m > 1000000 {
			return "", false
		}
		edits = myers.ComputeEdits(uri, strings.Join(a[prefix:endA], ""), strings.Join(b[prefix:endB], ""))
		for i, e := range edits {
			edits[i].Span = span.New(uri, span.NewPoint(e.Span.Start().Line()+prefix, 1, 0), span.NewPoint(e.Span.End().Line()+prefix, 1, 0))
		}
	}
	return formatPatch(gotextdiff.ToUnified(oldName, newName, before, edits)), true
}

// gotextdiff's display formatter omits zero hunk counts. Emit standard ranges so
// additions/deletions are accepted by patch parsers as well as the diff viewer.
func formatPatch(unified gotextdiff.Unified) string {
	if len(unified.Hunks) == 0 {
		return ""
	}
	var out strings.Builder
	fmt.Fprintf(&out, "--- %s\n+++ %s\n", unified.From, unified.To)
	lineRange := func(start, count int) string {
		if count == 0 {
			return fmt.Sprintf("%d,0", start-1)
		}
		if count == 1 {
			return fmt.Sprint(start)
		}
		return fmt.Sprintf("%d,%d", start, count)
	}
	for _, hunk := range unified.Hunks {
		oldCount, newCount := 0, 0
		for _, line := range hunk.Lines {
			if line.Kind != gotextdiff.Insert {
				oldCount++
			}
			if line.Kind != gotextdiff.Delete {
				newCount++
			}
		}
		fmt.Fprintf(&out, "@@ -%s +%s @@\n", lineRange(hunk.FromLine, oldCount), lineRange(hunk.ToLine, newCount))
		for _, line := range hunk.Lines {
			prefix := " "
			if line.Kind == gotextdiff.Insert {
				prefix = "+"
			}
			if line.Kind == gotextdiff.Delete {
				prefix = "-"
			}
			out.WriteString(prefix)
			out.WriteString(line.Content)
			if !strings.HasSuffix(line.Content, "\n") {
				out.WriteString("\n\\ No newline at end of file\n")
			}
		}
	}
	return out.String()
}
