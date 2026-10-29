package service

import (
	"context"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
)

// ContextBinder exposes Multica's context tools to one provider process.
// token, when set, is the route's bearer token. current reports the
// conversation and turn the process is working on. The returned release
// ends the route.
type ContextBinder func(ctx context.Context, token string, current func() map[string]any) (contextmcp.Binding, func(), error)

// contextServerEntry is Claude's MCP configuration for a bound route.
func contextServerEntry(name string, b contextmcp.Binding) map[string]any {
	return map[string]any{name: map[string]any{
		"type": "http", "url": b.URL, "headers": map[string]any{"Authorization": "Bearer " + b.Token},
	}}
}
