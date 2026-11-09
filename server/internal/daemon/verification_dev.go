//go:build verificationdev

package daemon

import (
	"context"
	"net"
	"net/url"

	"github.com/multica-ai/multica/server/internal/localconversation/service"
)

func verificationAgents() (map[string]AgentEntry, bool) {
	if !service.VerificationEnabled() {
		return nil, false
	}
	return map[string]AgentEntry{"claude": {Path: "/multica-verification/fake-provider"}, "codex": {Path: "/multica-verification/fake-provider"}}, true
}

// Verification runs the real local service without registering or claiming cloud work.
func (d *Daemon) runVerification(ctx context.Context) (bool, error) {
	if !service.VerificationEnabled() {
		return false, nil
	}
	if _, err := d.client.ListWorkspaces(ctx); err != nil {
		return true, err
	}
	// A verification host that runs a registry for this environment links its
	// phone through it. Desktop otherwise fills in the shared registry, which a
	// test runtime must never join, so only a loopback registry is used.
	if loopbackRegistry(d.cfg.P2PServerURL) {
		if err := d.startP2P(ctx); err != nil {
			d.logger.Warn("p2p: disabled for this run", "error", err)
		}
	}
	d.ready.Store(true)
	d.logger.Info("verification runtime ready; cloud task claims and provider discovery disabled")
	<-ctx.Done()
	return true, nil
}

func loopbackRegistry(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return false
	}
	if u.Hostname() == "localhost" {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}
