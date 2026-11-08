package localhost

import (
	"errors"
	"github.com/multica-ai/multica/server/internal/localconversation/service"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"net/http"
	"strconv"
)

func resourceError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrResourceRevision) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]string{"kind": "resources_changed", "message": err.Error()}})
		return
	}
	writeV2Error(w, err)
}
func (v *V2) resources(w http.ResponseWriter, r *http.Request, scopeID int64, id string) {
	page, err := v.svc.ResourcePage(r.Context(), scopeID, id, r.URL.Query().Get("cursor"))
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}
func (v *V2) changeDetail(w http.ResponseWriter, r *http.Request, scopeID int64, id, file string) {
	rev, err := strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
	if err != nil || rev < 0 {
		writeV2Error(w, service.ErrInvalidRequest)
		return
	}
	detail, err := v.svc.ChangeDetail(r.Context(), scopeID, id, file, rev)
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}
