package handler

import (
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"net/http"
	"strconv"
)

// ListChatSessionTasks hydrates all recipients' runs, rather than only the
// conversation's default agent. Session ownership remains the read boundary.
func (h *Handler) ListChatSessionTasks(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	session, ok := h.gatePublicChatSessionForUser(w, r, userID, workspaceID, chi.URLParam(r, "sessionId"))
	if !ok {
		return
	}
	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 200 {
			writeError(w, 400, "invalid limit")
			return
		}
		limit = n
	}
	beforeCreatedAt := pgtype.Timestamptz{InfinityModifier: pgtype.Infinity, Valid: true}
	beforeID := session.ID
	if raw := r.URL.Query().Get("before"); raw != "" {
		beforeCreatedAt, beforeID = parseTranscriptCursor(raw)
		if !beforeCreatedAt.Valid || !beforeID.Valid {
			writeError(w, 400, "invalid before cursor")
			return
		}
	}
	tasks, err := h.Queries.ListChatSessionTasks(r.Context(), db.ListChatSessionTasksParams{ChatSessionID: session.ID, BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID, RowLimit: int32(limit + 1)})
	if err != nil {
		writeError(w, 500, "failed to load conversation runs")
		return
	}
	if len(tasks) > limit {
		last := tasks[limit-1]
		w.Header().Set(HeaderAgentTasksNextCursor, transcriptCursor(last.CreatedAt.Time, last.ID))
		tasks = tasks[:limit]
	}
	out := make([]AgentTaskResponse, len(tasks))
	for i, t := range tasks {
		out[i] = taskToResponse(t, workspaceID)
	}
	writeJSON(w, http.StatusOK, out)
}
