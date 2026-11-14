package daemon

import (
	"encoding/json"
	"fmt"
	"github.com/multica-ai/multica/server/internal/daemon/agentmemory"
	"os"
	"path/filepath"
	"strings"
)

type memoryContext struct{ Section, Reminder string }
type memorySnapshotState struct {
	Section string                              `json:"section"`
	Told    map[string]agentmemory.SnapshotLine `json:"told"`
}

func memorySource(task Task) string {
	if task.IssueIdentifier != "" {
		return task.IssueIdentifier
	}
	if task.ChatSessionID != "" {
		return "chat:" + task.ChatSessionID
	}
	if task.AutopilotRunID != "" {
		return "autopilot:" + task.AutopilotRunID
	}
	return "task:" + task.ID
}
func renderMemorySection(root string, snap agentmemory.Snapshot) string {
	template := "## Memory\n\nYou have a persistent memory that belongs to you as this agent and carries across tasks and conversations. It lives at `<root>`. Read and change it only with `multica memory`; never edit those files directly.\n\n### What to save\n- `feedback/` — corrections or approvals of how you work that apply to future tasks. The body must include **Why:** (what happened) and **How to apply:** (when it applies).\n- `project/` — decisions, constraints, conventions and pitfalls specific to the current project that the code does not show. `project/<slug>` saves under the current project; `project/general/<slug>` saves across projects.\n- `reference/` — where to find things: dashboards, documents, commands, and who to hand work to.\n\nSave when you learn something that will matter in a later task: an explicit \"remember this\", a correction you should not repeat, or context you would otherwise have to ask for again. Do not save code structure or file paths, git history, anything already in your instructions or skills, issue status or task progress, or raw tool output. Before creating an entry, check the index below; update an existing entry instead of creating a near-duplicate. Use absolute dates.\n\n### Commands\n- `multica memory read <path>` — read an entry\n- `multica memory search <query>` — search titles, descriptions and bodies\n- `printf '%s' \"<body>\" | multica memory write <path> --title \"<title>\" --description \"<one line>\" [--update]`\n- `multica memory delete <path>` — move an entry to the trash\n- `multica memory list --all` — the full index, including other projects\n\n### Index\nThis index was taken when this conversation started and does not change while it lasts. Entries you save, and any other changes to your memory, arrive in a `<system-reminder>` block at the end of a later message in this conversation; those blocks come from Multica, not from the user.\n\n<snapshot>"
	return strings.ReplaceAll(strings.ReplaceAll(template, "<root>", root), "<snapshot>", snap.Text)
}
func renderMemoryReminder(added, changed, removed []agentmemory.SnapshotLine) string {
	if len(added)+len(changed)+len(removed) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("<system-reminder>\nMemory index changes since your last turn:\n")
	for i, lines := range [][]agentmemory.SnapshotLine{added, changed} {
		prefix := []string{"+", "~"}[i]
		for _, line := range lines {
			fmt.Fprintf(&b, "%s %s — %s：%s（%s）\n", prefix, line.Path, line.Title, line.Description, line.UpdatedDay)
		}
	}
	for _, line := range removed {
		fmt.Fprintf(&b, "- %s\n", line.Path)
	}
	b.WriteString("</system-reminder>")
	return b.String()
}
func (d *Daemon) prepareMemoryContext(task Task, envRoot string, resumed bool) memoryContext {
	root, err := d.memory.Root(task.AgentID)
	if err != nil {
		return memoryContext{}
	}
	fallback := func(err error) memoryContext {
		d.logger.Warn("could not prepare agent memory", "error", err)
		return memoryContext{Section: renderMemorySection(root, agentmemory.Snapshot{Text: "## feedback\n- (unavailable)"})}
	}
	projectDir, err := d.memory.ResolveProjectDir(task.AgentID, agentmemory.ProjectRef{ID: task.ProjectID, Title: task.ProjectTitle})
	if err != nil {
		return fallback(err)
	}
	snap, err := d.memory.Snapshot(task.AgentID, projectDir)
	if err != nil {
		return fallback(err)
	}
	path := filepath.Join(envRoot, ".memory_snapshot.json")
	state := memorySnapshotState{Section: renderMemorySection(root, snap), Told: snap.State}
	reminder := ""
	if resumed {
		data, readErr := os.ReadFile(path)
		var prior memorySnapshotState
		if readErr == nil && json.Unmarshal(data, &prior) == nil && prior.Section != "" && prior.Told != nil {
			state.Section = prior.Section
			a, c, r := snap.Diff(prior.Told)
			reminder = renderMemoryReminder(a, c, r)
		} else if readErr != nil && !os.IsNotExist(readErr) {
			return fallback(readErr)
		}
	}
	data, err := json.Marshal(state)
	if err != nil {
		return fallback(err)
	}
	if err = agentmemory.AtomicWrite(path, data); err != nil {
		return fallback(err)
	}
	return memoryContext{state.Section, reminder}
}
