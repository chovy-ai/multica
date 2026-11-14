package agentmemory

import "sort"

type SnapshotLine struct {
	Path        string `json:"path"`
	Title       string `json:"title"`
	Description string `json:"description"`
	UpdatedDay  string `json:"updated_day"`
}
type Snapshot struct {
	Text  string
	State map[string]SnapshotLine
}

func (m *Manager) Snapshot(id, projectDir string) (Snapshot, error) {
	entries, err := m.List(id)
	if err != nil {
		return Snapshot{}, err
	}
	projects, err := m.Projects(id)
	if err != nil {
		return Snapshot{}, err
	}
	eligible := []Entry{}
	other := 0
	for _, e := range entries {
		if e.Kind == "project" && e.ProjectDir != "general" && e.ProjectDir != projectDir {
			other++
			continue
		}
		eligible = append(eligible, e)
	}
	omitted := map[Kind]int{}
	text := renderIndex(eligible, projects, false, other, omitted)
	for len(text) > 8192 && len(eligible) > 0 {
		oldest := 0
		for i := range eligible {
			if eligible[i].UpdatedAt.Before(eligible[oldest].UpdatedAt) {
				oldest = i
			}
		}
		omitted[eligible[oldest].Kind]++
		eligible = append(eligible[:oldest], eligible[oldest+1:]...)
		text = renderIndex(eligible, projects, false, other, omitted)
	}
	snap := Snapshot{Text: text, State: map[string]SnapshotLine{}}
	for _, e := range eligible {
		snap.State[e.Path] = SnapshotLine{e.Path, e.Title, e.Description, e.UpdatedAt.UTC().Format("2006-01-02")}
	}
	return snap, nil
}
func (s Snapshot) Diff(prev map[string]SnapshotLine) (added, changed, removed []SnapshotLine) {
	for path, line := range s.State {
		old, ok := prev[path]
		if !ok {
			added = append(added, line)
		} else if old != line {
			changed = append(changed, line)
		}
	}
	for path, line := range prev {
		if _, ok := s.State[path]; !ok {
			removed = append(removed, line)
		}
	}
	for _, lines := range [][]SnapshotLine{added, changed, removed} {
		sort.Slice(lines, func(i, j int) bool { return lines[i].Path < lines[j].Path })
	}
	return
}
