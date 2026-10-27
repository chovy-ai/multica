package localhost

import "encoding/json"

// Wire types shared by the Desktop ↔ daemon WebSocket and the daemon ↔
// sidecar stdio link. testdata/protocol holds one JSON fixture per message;
// the Go and TypeScript test suites both decode those fixtures, so a field
// renamed on one side fails the other side's tests.

// Desktop → daemon requests.

type SessionParams struct {
	UserID string            `json:"userId"`
	APIURL string            `json:"apiUrl"`
	Env    map[string]string `json:"env"`
	// LegacyDataDir is Desktop's former in-process data directory, migrated
	// once into the sidecar's data directory.
	LegacyDataDir string `json:"legacyDataDir,omitempty"`
}

type SessionResult struct {
	ConnectionID string        `json:"connectionId"`
	Status       SidecarStatus `json:"status"`
	Instance     string        `json:"instance"`
}

type SubscribeParams struct {
	Since string `json:"since"`
}

type SubscribeResult struct {
	Cursor string `json:"cursor"`
	Resync bool   `json:"resync"`
}

type RequestParams struct {
	Scope  Scope           `json:"scope"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type HostReplyParams struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

type DrainResult struct {
	Busy int64 `json:"busy"`
}

// Daemon → Desktop notifications.

type EventNotification struct {
	Cursor string          `json:"cursor"`
	Event  json.RawMessage `json:"event"`
}

type HostRequestNotification struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

type HostRequestResolvedNotification struct {
	ID string `json:"id"`
}

type SidecarStatusNotification struct {
	Status   SidecarStatus `json:"status"`
	Instance string        `json:"instance"`
}

type ResyncNotification struct {
	Instance string `json:"instance"`
}

// Daemon → sidecar requests. init uses InitParams.

type SidecarSessionParams struct {
	ConnectionID  string            `json:"connectionId"`
	UserID        string            `json:"userId"`
	APIURL        string            `json:"apiUrl"`
	Env           map[string]string `json:"env"`
	LegacyDataDir string            `json:"legacyDataDir,omitempty"`
}

type SidecarRequestParams struct {
	ConnectionID string          `json:"connectionId"`
	Scope        Scope           `json:"scope"`
	Method       string          `json:"method"`
	Params       json.RawMessage `json:"params"`
}

type FileResolveParams struct {
	Scope   Scope  `json:"scope"`
	FileRef string `json:"fileRef"`
}

type FileResolveResult struct {
	Path     string `json:"path"`
	MimeType string `json:"mimeType"`
	Name     string `json:"name"`
}

type FileCommitParams struct {
	Scope    Scope  `json:"scope"`
	TempPath string `json:"tempPath"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
}

type FileCommitResult struct {
	ID string `json:"id"`
}

// Sidecar → daemon messages.

type SidecarEventParams struct {
	Seq   uint64          `json:"seq"`
	Event json.RawMessage `json:"event"`
}

type BusyParams struct {
	Count int64 `json:"count"`
}

type LogParams struct {
	Level   string         `json:"level"`
	Message string         `json:"message"`
	Fields  map[string]any `json:"fields,omitempty"`
}

type HostRequestParams struct {
	ConnectionID string          `json:"connectionId"`
	Kind         string          `json:"kind"`
	Payload      json.RawMessage `json:"payload"`
}
