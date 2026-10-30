package localhost

import (
	"encoding/json"
	"net/http"
)

// APIVersion is the Desktop ↔ daemon local conversation API version. Version
// 2 is the `/local/v2` API; the daemon no longer hosts a conversation sidecar.
const APIVersion = 2

// desktopUserIDFile, in the daemon profile, names the account Desktop is
// signed in to; only that account may use local conversations.
const desktopUserIDFile = ".desktop-user-id"

// appError is a request failure with a stable machine-readable kind.
type appError struct {
	kind    string
	message string
}

func (e *appError) Error() string { return e.message }

// AppError builds an application error with a stable machine-readable kind.
func AppError(kind, message string) error { return &appError{kind: kind, message: message} }

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
