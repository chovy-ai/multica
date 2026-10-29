package service

import (
	"context"
	"strings"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
)

// ContextBinder exposes Multica's context tools to one provider process.
// token, when set, is the route's bearer token. current reports the
// conversation and turn the process is working on. The returned release
// ends the route.
type ContextBinder func(ctx context.Context, token string, current func() map[string]any) (BoundContext, func(), error)

// BoundContext is a provider process's context route and the system prompt
// that describes it.
type BoundContext struct {
	contextmcp.Binding
	SystemPrompt string
}

// contextServerEntry is Claude's MCP configuration for a bound route. An
// hour-long call timeout keeps ask_user_question waiting for the user.
func contextServerEntry(name string, b contextmcp.Binding) map[string]any {
	return map[string]any{name: map[string]any{
		"type": "http", "url": b.URL, "headers": map[string]any{"Authorization": "Bearer " + b.Token}, "timeout": 3600000,
	}}
}

// ClaudeEnv is the environment of Claude Code in a local conversation:
// the daemon's, with MCP calls kept in the foreground so a question to the
// user stays attached to its turn.
func ClaudeEnv(environ []string) map[string]string {
	env := map[string]string{}
	for _, kv := range environ {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	env["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS"] = "0"
	return env
}
