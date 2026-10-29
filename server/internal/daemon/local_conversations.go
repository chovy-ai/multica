package daemon

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/multica-ai/multica/server/internal/daemon/localhost"
	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/codex"
	"github.com/multica-ai/multica/server/internal/localconversation/service"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

// openLocalConversations opens the Go-owned local conversation service and
// its /local/v2 API. The shared sidecar keeps serving /local/v1 until Desktop
// switches over; the two use separate storage.
func (d *Daemon) openLocalConversations(ctx context.Context, sidecar localhost.Sidecar) error {
	svc, err := service.Open(ctx, service.Options{
		Path:   filepath.Join(d.cfg.ProfileDir, "local-conversations", "conversations.sqlite"),
		Claude: d.claudeLauncher(sidecar),
		Codex:  d.codexLauncher(),
		Cloud:  d.contextCloud,
		Logger: d.logger.With("component", "local-conversations"),
	})
	if err != nil {
		return err
	}
	d.conversations = svc
	d.localV2 = localhost.NewV2(svc, d.cfg.LocalAPIToken, d.cfg.ProfileDir)
	return nil
}

// claudeLauncher starts one Claude adapter per conversation with the
// packaged Electron in Node mode, using the Claude Code executable the
// daemon resolves for cloud tasks.
func (d *Daemon) claudeLauncher(sidecar localhost.Sidecar) service.ClaudeLauncher {
	return func(ctx context.Context, conv sqlitedb.Conversation) (service.ClaudeSession, service.StartClaudeAdapter, error) {
		entry, ok := d.cfg.Agents["claude"]
		if !ok {
			return service.ClaudeSession{}, nil, errors.New("Claude Code is not installed on this computer")
		}
		resolved, _, err := d.resolveAgentEntryForLaunch(ctx, "claude", entry)
		if err != nil {
			return service.ClaudeSession{}, nil, err
		}
		fields := map[string]any{"executable": resolved.Path, "cwd": conv.Cwd}
		logger := d.logger.With("component", "claude-adapter", "conversation_id", conv.ID)
		start := func(ctx context.Context, handler claude.Handler) (service.ClaudeAdapter, error) {
			p, err := claude.Start(ctx, claude.AdapterCommand(sidecar.Electron, sidecar.ClaudeEntry, os.Environ()), handler, logger)
			if err != nil {
				return nil, err
			}
			return p, nil
		}
		return service.ClaudeSession{Fields: fields}, start, nil
	}
}

// codexLauncher runs one app-server per Codex conversation with the Codex
// executable the daemon resolves for cloud tasks.
func (d *Daemon) codexLauncher() service.CodexLauncher {
	return func(ctx context.Context, conv sqlitedb.Conversation) (service.CodexSession, service.StartCodexServer, error) {
		entry, ok := d.cfg.Agents["codex"]
		if !ok {
			return service.CodexSession{}, nil, errors.New("Codex is not installed on this computer")
		}
		resolved, _, err := d.resolveAgentEntryForLaunch(ctx, "codex", entry)
		if err != nil {
			return service.CodexSession{}, nil, err
		}
		logger := d.logger.With("component", "codex-app-server", "conversation_id", conv.ID)
		start := func(ctx context.Context, handler codex.Handler, env []string) (service.CodexServer, error) {
			s, err := codex.Start(ctx, codex.Command{Path: resolved.Path, Dir: conv.Cwd, Env: append(os.Environ(), env...)}, handler, logger)
			if err != nil {
				return nil, err
			}
			return s, nil
		}
		return service.CodexSession{Cwd: conv.Cwd}, start, nil
	}
}

// contextCloud gives context tools official data with the profile's
// credentials, only for conversations of the server this daemon signs in
// to: the token is not valid for another API origin.
func (d *Daemon) contextCloud(scope store.Scope, dir string) contextmcp.Cloud {
	if normalizeOrigin(scope.APIOrigin) != normalizeOrigin(d.cfg.ServerBaseURL) || d.client == nil {
		return nil
	}
	return &contextmcp.CloudClient{APIURL: d.cfg.ServerBaseURL, WorkspaceID: scope.WorkspaceID, Token: d.client.Token, CLIPath: d.cfg.LocalHostCLIPath, Dir: dir}
}

func normalizeOrigin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}
