package servicepreview

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"time"
)

type agentPort struct {
	scope        int64
	conversation string
	target       Target
	expires      time.Time
	cancel       context.CancelFunc
}

type AgentPort struct {
	Host      string    `json:"host"`
	Port      int       `json:"port"`
	ExpiresAt time.Time `json:"expires_at"`
}

func agentKey(scope int64, conversation string, target Target) string {
	return fmt.Sprintf("%d:%s:%s:%d", scope, conversation, target.Host, target.Port)
}

// agentAllowed is called with m.mu held. Registrations are never permanent policy.
func (m *Manager) agentAllowed(scope int64, conversation string, target Target) bool {
	entry := m.agentPorts[agentKey(scope, conversation, target)]
	if entry == nil || !time.Now().Before(entry.expires) {
		return false
	}
	return true
}

func (m *Manager) renewAgent(scope int64, conversation string, target Target) {
	if entry := m.agentPorts[agentKey(scope, conversation, target)]; entry != nil {
		entry.expires = time.Now().Add(Lease)
	}
}

func (m *Manager) allowedGrant(g *grant) bool {
	return m.allowed(g.target.Port) || m.agentAllowed(g.scope, g.conversation, g.target)
}

func (m *Manager) removeAgentPortLocked(key string) {
	if entry := m.agentPorts[key]; entry != nil {
		entry.cancel()
		delete(m.agentPorts, key)
	}
	for id, g := range m.grants {
		if !m.allowedGrant(g) {
			m.removeLocked(id)
		}
	}
}

func (m *Manager) clearAgentPortsLocked() {
	for key, entry := range m.agentPorts {
		entry.cancel()
		delete(m.agentPorts, key)
	}
}

// ClearAgentPorts revokes temporary registrations without editing manual ports.
func (m *Manager) ClearAgentPorts() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.revoked++
	m.clearAgentPortsLocked()
	for id, g := range m.grants {
		if !m.allowedGrant(g) {
			m.removeLocked(id)
		}
	}
}

func (m *Manager) AgentPorts() []int {
	m.mu.Lock()
	defer m.mu.Unlock()
	unique := map[int]bool{}
	for _, entry := range m.agentPorts {
		if time.Now().Before(entry.expires) {
			unique[entry.target.Port] = true
		}
	}
	ports := make([]int, 0, len(unique))
	for port := range unique {
		ports = append(ports, port)
	}
	sort.Ints(ports)
	return ports
}

func listening(ctx context.Context, target Target) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	hosts := []string{target.Host}
	if target.Host == "localhost" {
		hosts = []string{"::1", "127.0.0.1"}
	}
	for _, host := range hosts {
		conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(target.Port)))
		if err == nil {
			conn.Close()
			return true
		}
	}
	return false
}

func (m *Manager) watchAgentPort(ctx context.Context, key string, entry *agentPort) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			alive := listening(ctx, entry.target)
			m.mu.Lock()
			if m.agentPorts[key] != entry {
				m.mu.Unlock()
				return
			}
			if !alive || !time.Now().Before(entry.expires) {
				m.removeAgentPortLocked(key)
				m.mu.Unlock()
				return
			}
			m.mu.Unlock()
		}
	}
}

// Agent changes only this conversation's temporary loopback registrations.
// Starting commands remains with the provider's existing shell/approval path.
func (m *Manager) Agent(ctx context.Context, scope int64, conversation, operation, host string, port int) (any, error) {
	if scope < 1 || conversation == "" {
		return nil, fail("forbidden", 403)
	}
	if err := m.check(ctx, scope, conversation); err != nil {
		return nil, fail("conversation_not_found", 404)
	}
	if operation == "list" {
		enabled := m.open()
		m.mu.Lock()
		defer m.mu.Unlock()
		entries := []AgentPort{}
		for _, entry := range m.agentPorts {
			if entry.scope == scope && entry.conversation == conversation && time.Now().Before(entry.expires) {
				entries = append(entries, AgentPort{entry.target.Host, entry.target.Port, entry.expires})
			}
		}
		sort.Slice(entries, func(i, j int) bool {
			if entries[i].Port == entries[j].Port {
				return entries[i].Host < entries[j].Host
			}
			return entries[i].Port < entries[j].Port
		})
		return map[string]any{"services": entries, "device_link_enabled": enabled}, nil
	}
	host, ok := Loopback(host)
	if !ok || port < 1 || port > 65535 {
		return nil, fail("invalid_request", 400)
	}
	target := Target{host, port}
	key := agentKey(scope, conversation, target)
	if operation == "remove" {
		m.mu.Lock()
		m.removeAgentPortLocked(key)
		m.mu.Unlock()
		return map[string]bool{"removed": true}, nil
	}
	if operation != "register" {
		return nil, fail("invalid_request", 400)
	}
	m.mu.Lock()
	generation := m.revoked
	m.mu.Unlock()
	if !listening(ctx, target) {
		return nil, fail("target_unreachable", 502)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	if generation != m.revoked {
		m.mu.Unlock()
		return nil, fail("service_sharing_disabled", 403)
	}
	entry := m.agentPorts[key]
	if entry == nil {
		if len(m.agentPorts) >= 64 {
			m.mu.Unlock()
			return nil, fail("preview_connection_limited", 429)
		}
		watch, cancel := context.WithCancel(context.Background())
		entry = &agentPort{scope: scope, conversation: conversation, target: target, cancel: cancel}
		m.agentPorts[key] = entry
		go m.watchAgentPort(watch, key, entry)
	}
	entry.expires = time.Now().Add(Lease)
	result := AgentPort{host, port, entry.expires}
	m.mu.Unlock()
	return map[string]any{"service": result, "device_link_enabled": m.open()}, nil
}

// Prepare registers a live loopback service before an Agent opens its preview.
func (m *Manager) Prepare(ctx context.Context, scope int64, conversation, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return fail("invalid_request", 400)
	}
	host, ok := Loopback(u.Hostname())
	if !ok {
		return nil
	}
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil {
			return fail("invalid_request", 400)
		}
	}
	_, err = m.Agent(ctx, scope, conversation, "register", host, port)
	return err
}
