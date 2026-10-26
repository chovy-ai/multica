package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func chatModelFixture(t *testing.T, provider string) (agentID, sessionID, runtimeID string) {
	t.Helper()
	if testHandler == nil {
		t.Skip("database not available")
	}
	runtimeID = dbfx.Runtime(t, "Chat Model Runtime", testutil.Cols{"provider": provider})
	agentID = dbfx.Agent(t, "Chat Model Agent", runtimeID, testutil.Cols{"model": "gpt-default-model"})
	sessionID = dbfx.ChatSession(t, agentID, testutil.Cols{"title": "Model selection", "explicitly_created_at": testutil.Raw("now()")})
	dbfx.Cleanup(t, `DELETE FROM agent_task_queue WHERE agent_id = $1`, agentID)
	return
}

func sendChatModelRequest(t *testing.T, sessionID string, body map[string]any, status int) *testutil.Response {
	t.Helper()
	req := withURLParam(newRequest(http.MethodPost, "/api/chat/sessions/"+sessionID+"/messages", body), "sessionId", sessionID)
	return testutil.Call(t, testHandler.SendChatMessage, withChatTestWorkspaceCtx(t, req)).Want(status)
}

func TestSendChatMessageModelOverrideRejectsInvalidInputAtomically(t *testing.T) {
	agentID, sessionID, _ := chatModelFixture(t, "codex")
	for _, tc := range []struct {
		name  string
		model any
	}{
		{name: "null", model: nil},
		{name: "number", model: 42},
		{name: "boolean", model: true},
		{name: "object", model: map[string]string{"id": "gpt-test-model"}},
		{name: "array", model: []string{"gpt-test-model"}},
		{name: "empty", model: ""},
		{name: "whitespace", model: "  "},
		{name: "control", model: "gpt-test\n"},
		{name: "too long", model: strings.Repeat("x", 257)},
		{name: "other provider", model: "claude-sonnet-4-6"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sendChatModelRequest(t, sessionID, map[string]any{"content": "must not persist", "model": tc.model}, http.StatusBadRequest)
		})
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id = $1`, sessionID); count != 0 {
		t.Fatalf("rejected model persisted %d messages", count)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE agent_id = $1`, agentID); count != 0 {
		t.Fatalf("rejected model enqueued %d tasks", count)
	}
}

func TestSendChatMessageModelOverrideRejectsRuntimeManagedModels(t *testing.T) {
	for _, provider := range []string{"qwenpaw", "mcode", "zeroclaw", "qoder_cloud"} {
		t.Run(provider, func(t *testing.T) {
			agentID, sessionID, _ := chatModelFixture(t, provider)
			sendChatModelRequest(t, sessionID, map[string]any{"content": "no global changes", "model": "custom-model"}, http.StatusBadRequest)
			if count := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE agent_id = $1`, agentID); count != 0 {
				t.Fatalf("runtime-managed model enqueued %d tasks", count)
			}
		})
	}
}

func TestSendChatMessageModelOverrideSurvivesClaimAndRetryWithoutChangingAgent(t *testing.T) {
	ctx := context.Background()
	agentID, sessionID, runtimeID := chatModelFixture(t, "codex")
	var sent, defaultSent SendChatMessageResponse
	sendChatModelRequest(t, sessionID, map[string]any{"content": "selected turn", "model": "  gpt-selected-model  "}, http.StatusCreated).JSON(&sent)
	sendChatModelRequest(t, sessionID, map[string]any{"content": "inherit default"}, http.StatusCreated).JSON(&defaultSent)
	runtime, err := testHandler.Queries.GetAgentRuntime(ctx, parseUUID(runtimeID))
	if err != nil {
		t.Fatal(err)
	}
	assertClaim := func(taskID, want string) db.AgentTaskQueue {
		t.Helper()
		claimed, err := testHandler.TaskService.ClaimTask(ctx, parseUUID(agentID))
		if err != nil || claimed == nil {
			t.Fatalf("claim: task=%v err=%v", claimed, err)
		}
		if uuidToString(claimed.ID) != taskID {
			t.Fatalf("claim id=%s, want %s", uuidToString(claimed.ID), taskID)
		}
		response, _, _, _, _, failure := testHandler.buildClaimedTaskResponse(newOwnerDaemonRequest(http.MethodPost, "/claim", nil), claimed, runtime, runtimeID, testWorkspaceID)
		if failure != nil || response.Agent == nil || response.Agent.Model != want {
			t.Fatalf("claim model: response=%+v failure=%+v, want %q", response.Agent, failure, want)
		}
		agent, err := testHandler.Queries.GetAgent(ctx, parseUUID(agentID))
		if err != nil || agent.Model.String != "gpt-default-model" {
			t.Fatalf("global Agent changed: model=%q err=%v", agent.Model.String, err)
		}
		return *claimed
	}
	claimed := assertClaim(sent.TaskID, "gpt-selected-model")
	override, err := service.ChatTaskModelOverride(claimed.Context)
	if err != nil || override == nil || *override != "gpt-selected-model" {
		t.Fatalf("durable model=%v err=%v", override, err)
	}
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'failed', completed_at = now(), failure_reason = 'agent_error' WHERE id = $1`, sent.TaskID)
	retry, err := testHandler.Queries.CreateRetryTask(ctx, db.CreateRetryTaskParams{ID: claimed.ID})
	if err != nil {
		t.Fatal(err)
	}
	if string(retry.Context) != string(claimed.Context) {
		t.Fatalf("retry lost model context: %s != %s", retry.Context, claimed.Context)
	}
	assertClaim(uuidToString(retry.ID), "gpt-selected-model")
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE id = $1`, uuidToString(retry.ID))
	defaultTask := assertClaim(defaultSent.TaskID, "gpt-default-model")
	if len(defaultTask.Context) != 0 {
		t.Fatalf("omitted override changed default context: %s", defaultTask.Context)
	}
}

func TestSendDirectChatModelOverrideUsesLockedCarrierRuntime(t *testing.T) {
	ctx := context.Background()
	agentID, sessionID, _ := chatModelFixture(t, "codex")
	loadedAgent, err := testHandler.Queries.GetAgent(ctx, parseUUID(agentID))
	if err != nil {
		t.Fatal(err)
	}
	session, err := testHandler.Queries.GetChatSession(ctx, parseUUID(sessionID))
	if err != nil {
		t.Fatal(err)
	}
	newRuntimeID := dbfx.Runtime(t, "New Runtime", testutil.Cols{"provider": "qwenpaw"})
	dbfx.Exec(t, `UPDATE agent SET runtime_id = $1 WHERE id = $2`, newRuntimeID, agentID)
	model := "gpt-selected-model"
	_, err = testHandler.TaskService.SendDirectChatMessage(ctx, session, loadedAgent, parseUUID(testUserID), "stale carrier", nil, "member", parseUUID(testUserID), service.DirectChatSendOptions{Model: &model})
	if !errors.Is(err, service.ErrChatModelOverride) {
		t.Fatalf("stale runtime accepted model: %v", err)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE agent_id = $1`, agentID); count != 0 {
		t.Fatalf("stale runtime enqueued %d tasks", count)
	}
}

func TestClaimChatModelOverrideRejectsCorruptContext(t *testing.T) {
	ctx := context.Background()
	agentID, sessionID, runtimeID := chatModelFixture(t, "codex")
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": runtimeID, "chat_session_id": sessionID,
		"status": "dispatched", "dispatched_at": testutil.Raw("now()"),
		"context": testutil.Raw(`'{"chat_model_override":123}'::jsonb`),
	})
	task, err := testHandler.Queries.GetAgentTask(ctx, parseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := testHandler.Queries.GetAgentRuntime(ctx, parseUUID(runtimeID))
	if err != nil {
		t.Fatal(err)
	}
	response, _, _, _, _, failure := testHandler.buildClaimedTaskResponse(newOwnerDaemonRequest(http.MethodPost, "/claim", nil), &task, runtime, runtimeID, testWorkspaceID)
	if failure == nil || failure.status != http.StatusConflict || response.Agent != nil {
		t.Fatalf("corrupt model was dispatched: Agent=%+v failure=%+v", response.Agent, failure)
	}
	persisted, err := testHandler.Queries.GetAgentTask(ctx, task.ID)
	if err != nil || persisted.Status != "failed" {
		t.Fatalf("invalid task not settled: status=%s err=%v", persisted.Status, err)
	}
}
