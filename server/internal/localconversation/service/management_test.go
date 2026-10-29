package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateChoosesTheWorkingDirectory(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	own, err := f.svc.Create(ctx, CreateCommand{ScopeID: f.scopeID, ID: "conv-1", Provider: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if own.Title != DefaultTitle || own.TitleMode != "auto" {
		t.Fatalf("default title = %q/%q", own.Title, own.TitleMode)
	}
	if info, err := os.Stat(own.Cwd); err != nil || !info.IsDir() || !strings.Contains(own.Cwd, filepath.Join("workdirs")) {
		t.Fatalf("private cwd %q: %v", own.Cwd, err)
	}

	folder := t.TempDir()
	project, err := f.svc.AddFolderProject(ctx, f.scopeID, folder)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := f.svc.AddFolderProject(ctx, f.scopeID, folder)
	if again.ID != project.ID {
		t.Fatal("adding the same folder twice created two projects")
	}
	inFolder, err := f.svc.Create(ctx, CreateCommand{ScopeID: f.scopeID, ID: "conv-2", Provider: "claude", Title: " Plan ", FolderProjectID: project.ID})
	if err != nil || inFolder.Cwd != project.Path || inFolder.Title != "Plan" || inFolder.TitleMode != "manual" {
		t.Fatalf("folder conversation = %+v, %v", inFolder, err)
	}
	shared, err := f.svc.Create(ctx, CreateCommand{ScopeID: f.scopeID, ID: "conv-3", Provider: "claude", DirectorySourceID: "conv-2"})
	if err != nil || shared.Cwd != project.Path {
		t.Fatalf("shared directory = %+v, %v", shared, err)
	}

	for _, bad := range []CreateCommand{
		{ScopeID: f.scopeID, ID: "x", Provider: "codex"},
		{ScopeID: f.scopeID, ID: "x", Provider: "claude", FolderProjectID: project.ID, DirectorySourceID: "conv-2"},
		{ScopeID: f.scopeID, ID: "x", Provider: "claude", Title: strings.Repeat("长", 257)},
	} {
		if _, err := f.svc.Create(ctx, bad); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("Create(%+v) = %v", bad, err)
		}
	}
	if _, err := f.svc.AddFolderProject(ctx, f.scopeID, "relative/dir"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("relative folder = %v", err)
	}
}

func TestUpdateMetadataPublishesTheSummary(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	before, _ := f.svc.Store().Conversation(ctx, "conv-1")

	title, pinned, project := "Renamed", true, "p-1"
	conv, err := f.svc.UpdateMetadata(ctx, f.scopeID, "conv-1", MetadataUpdate{Title: &title, Pinned: &pinned, SetProject: true, ProjectID: &project})
	if err != nil {
		t.Fatal(err)
	}
	if conv.Title != title || conv.TitleMode != "manual" || conv.Pinned != 1 || conv.ProjectID.String != project || conv.SummarySeq <= before.SummarySeq {
		t.Fatalf("after update = %+v", conv)
	}
	conv, err = f.svc.UpdateMetadata(ctx, f.scopeID, "conv-1", MetadataUpdate{SetProject: true})
	if err != nil || conv.ProjectID.Valid || conv.Pinned != 1 {
		t.Fatalf("clearing the project = %+v, %v", conv, err)
	}
	events, _ := f.svc.Store().EventsAfter(ctx, "conv-1", 0, 100, 10)
	if len(events) != 2 || events[0].Type != "conversation.updated" {
		t.Fatalf("events = %+v", events)
	}
}

func TestSetDirectoryOnlyBeforeTheFirstMessage(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	dir := t.TempDir()
	conv, err := f.svc.SetDirectory(ctx, f.scopeID, "conv-1", dir)
	resolved, _ := filepath.EvalSymlinks(dir)
	if err != nil || conv.Cwd != resolved {
		t.Fatalf("set directory = %q, %v", conv.Cwd, err)
	}
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SetDirectory(ctx, f.scopeID, "conv-1", t.TempDir()); !errors.Is(err, ErrConversationStarted) {
		t.Fatalf("set directory after a message = %v", err)
	}
}
