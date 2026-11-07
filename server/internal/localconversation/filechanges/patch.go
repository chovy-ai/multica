package filechanges

import (
	"regexp"
	"strconv"
	"strings"
)

var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// Apply accepts native unified hunks with exact old-line matching. No offsets or fuzz.
func Apply(before, patch, kind string) (string, bool) {
	if patch == "" {
		return before, kind == "move"
	}
	if kind == "add" && !strings.Contains(patch, "@@") {
		return patch, before == ""
	}
	if kind == "delete" && !strings.Contains(patch, "@@") {
		return "", patch == before
	}
	old := lines(before)
	var out []string
	pos, hunks := 0, 0
	p := strings.Split(patch, "\n")
	for i := 0; i < len(p); {
		m := hunkHeader.FindStringSubmatch(p[i])
		if m == nil {
			if hunks > 0 && p[i] != "" {
				return "", false
			}
			i++
			continue
		}
		start, _ := strconv.Atoi(m[1])
		oldCount, newCount := 1, 1
		if m[2] != "" {
			oldCount, _ = strconv.Atoi(m[2])
		}
		if m[4] != "" {
			newCount, _ = strconv.Atoi(m[4])
		}
		if start > 0 && oldCount != 0 {
			start--
		}
		if start < pos || start > len(old) {
			return "", false
		}
		out = append(out, old[pos:start]...)
		pos = start
		used, added := 0, 0
		i++
		hunks++
		for i < len(p) && !strings.HasPrefix(p[i], "@@") {
			line := p[i]
			if line == "" {
				if i == len(p)-1 {
					i++
					break
				}
				return "", false
			}
			if line[0] != ' ' && line[0] != '+' && line[0] != '-' {
				return "", false
			}
			content := line[1:] + "\n"
			if i+1 < len(p) && strings.HasPrefix(p[i+1], `\ No newline at end of file`) {
				content = line[1:]
				i++
			}
			if line[0] != '+' {
				if pos >= len(old) || old[pos] != content {
					return "", false
				}
				pos++
				used++
			}
			if line[0] != '-' {
				out = append(out, content)
				added++
			}
			i++
			if used == oldCount && added == newCount {
				break
			}
		}
		if used != oldCount || added != newCount {
			return "", false
		}
	}
	if hunks == 0 {
		return "", false
	}
	out = append(out, old[pos:]...)
	return strings.Join(out, ""), true
}

func lines(s string) []string {
	if s == "" {
		return nil
	}
	l := strings.SplitAfter(s, "\n")
	if l[len(l)-1] == "" {
		l = l[:len(l)-1]
	}
	return l
}
