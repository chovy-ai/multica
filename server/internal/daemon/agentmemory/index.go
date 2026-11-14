package agentmemory

import (
	"fmt"
	"os"
	"sort"
	"strings"
)

func entryLine(e Entry) string {
	return fmt.Sprintf("- %s — %s：%s（%s）", e.Path, e.Title, e.Description, e.UpdatedAt.UTC().Format("2006-01-02"))
}
func renderIndex(entries []Entry, projects []Project, full bool, other int, omitted map[Kind]int) string {
	titles := map[string]string{}
	for _, p := range projects {
		titles[p.Dir] = p.Title
	}
	var b strings.Builder
	if full {
		b.WriteString("# Memory\n\n")
	}
	for i, kind := range []Kind{"feedback", "project", "reference"} {
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "## %s\n", kind)
		count := 0
		if kind == "project" {
			grouped := map[string][]Entry{}
			for _, e := range entries {
				if e.Kind == kind {
					grouped[e.ProjectDir] = append(grouped[e.ProjectDir], e)
				}
			}
			dirs := make([]string, 0, len(grouped))
			for dir := range grouped {
				dirs = append(dirs, dir)
			}
			sort.Slice(dirs, func(i, j int) bool {
				if dirs[i] == "general" {
					return true
				}
				if dirs[j] == "general" {
					return false
				}
				return dirs[i] < dirs[j]
			})
			for _, dir := range dirs {
				title := titles[dir]
				if title == "" {
					title = dir
				}
				fmt.Fprintf(&b, "### %s\n", strings.Join(strings.Fields(title), " "))
				for _, e := range grouped[dir] {
					b.WriteString(entryLine(e) + "\n")
					count++
				}
			}
		} else {
			for _, e := range entries {
				if e.Kind == kind {
					b.WriteString(entryLine(e) + "\n")
					count++
				}
			}
		}
		if count == 0 {
			b.WriteString("- (none)\n")
		}
		if omitted[kind] > 0 {
			fmt.Fprintf(&b, "- (%d older entries omitted; run `multica memory list --all`)\n", omitted[kind])
		}
		if kind == "project" && other > 0 {
			fmt.Fprintf(&b, "- (%d more entries in other projects; run `multica memory list --all`)\n", other)
		}
	}
	return b.String()
}
func (m *Manager) writeIndex(id string) error {
	entries, err := m.List(id)
	if err != nil {
		return err
	}
	projects, err := m.Projects(id)
	if err != nil {
		return err
	}
	root, err := m.Root(id)
	if err != nil {
		return err
	}
	path, err := safePath(root, "MEMORY.md")
	if err != nil {
		return err
	}
	if err = AtomicWrite(path, []byte(renderIndex(entries, projects, true, 0, nil))); err != nil {
		_ = os.Remove(path)
	}
	return err
}
func (m *Manager) Index(id string) (string, error) {
	defer m.lock(id)()
	if err := m.writeIndex(id); err != nil {
		return "", err
	}
	root, err := m.Root(id)
	if err != nil {
		return "", err
	}
	path, err := safePath(root, "MEMORY.md")
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	return string(data), err
}
func (m *Manager) refresh(id string) error {
	if err := m.rebuildFTS(id); err != nil {
		return err
	}
	return m.writeIndex(id)
}
