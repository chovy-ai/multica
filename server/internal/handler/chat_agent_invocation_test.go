package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func invokeDefinedAgents(t *testing.T, sessionID string, agentIDs []string, status int) SendChatMessageResponse {
	t.Helper()
	req := withURLParam(newRequest(http.MethodPost, "/api/chat/sessions/"+sessionID+"/agent-messages", map[string]any{"content": "Review this change", "agent_ids": agentIDs}), "sessionId", sessionID)
	response := testutil.Call(t, testHandler.SendChatAgentMessage, withChatTestWorkspaceCtx(t, req)).Want(status)
	var out SendChatMessageResponse
	if status == http.StatusCreated {
		response.JSON(&out)
	}
	return out
}

func TestChatAgentInvocationRoutesDefinedAgentsAndPreservesDefaultMemory(t *testing.T) {
	ctx := context.Background()
	root, sessionID, runtimeID := chatModelFixture(t, "codex")
	first := dbfx.Agent(t, "Design reviewer", runtimeID, testutil.Cols{"model": "gpt-design", "instructions": "Review interaction design"})
	second := dbfx.Agent(t, "Code reviewer", runtimeID, testutil.Cols{"model": "gpt-code", "instructions": "Review implementation"})
	dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE chat_session_id=$1`, sessionID)
	dbfx.Exec(t, `UPDATE chat_session SET session_id='default-memory',runtime_id=$2,work_dir='/tmp/default-work' WHERE id=$1`, sessionID, runtimeID)
	sent := invokeDefinedAgents(t, sessionID, []string{first, second, first}, http.StatusCreated)
	if len(sent.AgentRuns) != 2 {
		t.Fatalf("expected two recipients, got %+v", sent)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE chat_session_id=$1 AND agent_id=$2`, sessionID, root); n != 0 {
		t.Fatal("default agent also ran")
	}
	runtime, err := testHandler.Queries.GetAgentRuntime(ctx, parseUUID(runtimeID))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ id, model, instructions string }{{first, "gpt-design", "Review interaction design"}, {second, "gpt-code", "Review implementation"}} {
		task, err := testHandler.TaskService.ClaimTask(ctx, parseUUID(item.id))
		if err != nil || task == nil {
			t.Fatalf("claim %s: %v", item.id, err)
		}
		response, _, _, _, _, failure := testHandler.buildClaimedTaskResponse(newOwnerDaemonRequest(http.MethodPost, "/claim", nil), task, runtime, runtimeID, testWorkspaceID)
		if failure != nil || response.Agent == nil || response.Agent.ID != item.id || response.Agent.Model != item.model || response.Agent.Instructions != item.instructions {
			t.Fatalf("wrong configured agent: %+v %v", response.Agent, failure)
		}
		if response.PriorSessionID != "" || response.PriorWorkDir != "" {
			t.Fatalf("another agent's memory leaked: %q %q", response.PriorSessionID, response.PriorWorkDir)
		}
		dbfx.Exec(t, `UPDATE agent_task_queue SET status='running' WHERE id=$1`, uuidToString(task.ID))
		if _, _, err := testHandler.TaskService.CompleteTaskWithTransition(ctx, task.ID, []byte(`{"output":"Review completed"}`), "memory-"+item.id, "/tmp/reviewer-"+item.id, "", false, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	chat, err := testHandler.Queries.GetChatSession(ctx, parseUUID(sessionID))
	if err != nil || chat.SessionID.String != "default-memory" {
		t.Fatalf("default resume pointer changed: %+v %v", chat, err)
	}
	invokeDefinedAgents(t, sessionID, []string{first}, http.StatusCreated)
	task, err := testHandler.TaskService.ClaimTask(ctx, parseUUID(first))
	if err != nil || task == nil {
		t.Fatal(err)
	}
	response, _, _, _, _, failure := testHandler.buildClaimedTaskResponse(newOwnerDaemonRequest(http.MethodPost, "/claim", nil), task, runtime, runtimeID, testWorkspaceID)
	if failure != nil || response.PriorSessionID != "memory-"+first {
		t.Fatalf("agent-specific continuity lost: %q %v", response.PriorSessionID, failure)
	}
	req := withURLParam(newRequest(http.MethodGet, "/api/chat/sessions/"+sessionID+"/tasks", nil), "sessionId", sessionID)
	var tasks []AgentTaskResponse
	testutil.Call(t, testHandler.ListChatSessionTasks, withChatTestWorkspaceCtx(t, req)).Want(http.StatusOK).JSON(&tasks)
	if len(tasks) != 3 || tasks[0].ChatInvocationGroupID == "" || tasks[0].ChatInvokedAgentName == "" {
		t.Fatalf("missing authoritative invocation projection: %+v", tasks)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1 AND role='assistant'`, sessionID); n != 2 {
		t.Fatalf("expected both results, got %d", n)
	}
}

func TestChatAgentInvocationRejectsUnauthorizedBatchWithoutWrites(t *testing.T) {
	_, sessionID, runtimeID := chatModelFixture(t, "codex")
	dbfx.Exec(t, `UPDATE agent_runtime SET visibility='public' WHERE id=$1`, runtimeID)
	good := dbfx.Agent(t, "Available reviewer", runtimeID)
	other := dbfx.User(t, "Another owner", "chat-agent-other@example.test")
	denied := dbfx.Agent(t, "Private reviewer", runtimeID, testutil.Cols{"owner_id": other})
	for _, targets := range [][]string{{good, denied}, {"invalid"}, {}, {good, good, good, good, good, good}} {
		status := http.StatusBadRequest
		if len(targets) == 2 {
			status = http.StatusForbidden
		}
		invokeDefinedAgents(t, sessionID, targets, status)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1`, sessionID); n != 0 {
		t.Fatal("rejected invocation persisted input")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE chat_session_id=$1`, sessionID); n != 0 {
		t.Fatal("rejected invocation queued work")
	}
}

func TestChatAgentInvocationHasIndependentAttachmentOwnership(t *testing.T) {
	_, sessionID, runtimeID := chatModelFixture(t, "codex")
	a := dbfx.Agent(t, "First attached reviewer", runtimeID)
	b := dbfx.Agent(t, "Second attached reviewer", runtimeID)
	dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE chat_session_id=$1`, sessionID)
	attachmentID := dbfx.Insert(t, "attachment", testutil.Cols{"workspace_id": testWorkspaceID, "uploader_type": "member", "uploader_id": testUserID, "filename": "review.txt", "url": "https://example.test/review.txt", "content_type": "text/plain", "size_bytes": 12})
	dbfx.Cleanup(t, `DELETE FROM attachment WHERE chat_session_id=$1`, sessionID)
	req := withURLParam(newRequest(http.MethodPost, "/agent-messages", map[string]any{"content": "Review this attachment", "agent_ids": []string{a, b}, "attachment_ids": []string{attachmentID}}), "sessionId", sessionID)
	var sent SendChatMessageResponse
	testutil.Call(t, testHandler.SendChatAgentMessage, withChatTestWorkspaceCtx(t, req)).Want(http.StatusCreated).JSON(&sent)
	for _, run := range sent.AgentRuns {
		if n := dbfx.Count(t, `SELECT count(*) FROM attachment WHERE chat_message_id=$1`, run.MessageID); n != 1 {
			t.Fatalf("run %s lost its attachment", run.TaskID)
		}
	}
	if _, err := testHandler.TaskService.CancelTask(context.Background(), parseUUID(sent.TaskID)); err != nil {
		t.Fatal(err)
	}
	otherRun := sent.AgentRuns[1]
	if n := dbfx.Count(t, `SELECT count(*) FROM attachment WHERE chat_message_id=$1`, otherRun.MessageID); n != 1 {
		t.Fatal("cancelling one run detached the other's file")
	}
}
