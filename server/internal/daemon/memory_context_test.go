package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/agentmemory"
)

func TestMemoryContextFreezesBriefAndRemindsOnce(t *testing.T) {
	d := memoryTestDaemon(t)
	env := t.TempDir()
	task := Task{AgentID: memoryTestAgent}
	in := agentmemory.WriteInput{Path: "feedback/original", Title: "Original", Description: "Description", Body: "Body", Mode: "create"}
	if _, _, err := d.memory.Write(task.AgentID, in); err != nil {
		t.Fatal(err)
	}
	first := d.prepareMemoryContext(task, env, false)
	if first.Reminder != "" || !strings.Contains(first.Section, "feedback/original.md") {
		t.Fatal(first)
	}
	in.Path = "reference/added"
	if _, _, err := d.memory.Write(task.AgentID, in); err != nil {
		t.Fatal(err)
	}
	in.Path = "feedback/original"
	in.Mode = "update"
	in.Title = "Changed"
	if _, _, err := d.memory.Write(task.AgentID, in); err != nil {
		t.Fatal(err)
	}
	resumed := d.prepareMemoryContext(task, env, true)
	if first.Section != resumed.Section || !strings.Contains(resumed.Reminder, "+ reference/added.md") || !strings.Contains(resumed.Reminder, "~ feedback/original.md") {
		t.Fatal(resumed)
	}
	if next := d.prepareMemoryContext(task, env, true); next.Section != first.Section || next.Reminder != "" {
		t.Fatal(next)
	}
	if _, err := d.memory.Delete(task.AgentID, "reference/added"); err != nil {
		t.Fatal(err)
	}
	if next := d.prepareMemoryContext(task, env, true); !strings.Contains(next.Reminder, "- reference/added.md") {
		t.Fatal(next)
	}
	fresh := d.prepareMemoryContext(task, env, false)
	if fresh.Reminder != "" || fresh.Section == first.Section {
		t.Fatal("fresh retry must replace snapshot", fresh)
	}
	if err := os.WriteFile(filepath.Join(env, ".memory_snapshot.json"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if next := d.prepareMemoryContext(task, env, true); next.Section != fresh.Section || next.Reminder != "" {
		t.Fatal(next)
	}
	root, _ := d.memory.Root(task.AgentID)
	if err := os.RemoveAll(filepath.Join(root, "feedback")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "feedback"), []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if next := d.prepareMemoryContext(task, env, true); !strings.Contains(next.Section, "(unavailable)") || next.Reminder != "" {
		t.Fatal(next)
	}
}
func TestMemoryReminderAtPromptEnd(t *testing.T) {
	prompt := BuildPrompt(Task{}, "claude", WithMemoryReminder("<system-reminder>test</system-reminder>"))
	if !strings.HasSuffix(strings.TrimSpace(prompt), "<system-reminder>test</system-reminder>") {
		t.Fatal(prompt)
	}
}
