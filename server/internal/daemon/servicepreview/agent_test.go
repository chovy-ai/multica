package servicepreview

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestAgentRegistersOnlyLiveConversationServicesWithoutChangingManualPolicy(t *testing.T) {
	m, cmd := fixture(t)
	if err := m.SetPolicy(Policy{Ports: []int{}}); err != nil {
		t.Fatal(err)
	}
	m.check = func(_ context.Context, scope int64, id string) error {
		if scope != 1 || (id != "conversation" && id != "other") {
			return fmt.Errorf("foreign conversation")
		}
		return nil
	}
	ctx := context.Background()
	if _, err := m.Agent(ctx, 1, "conversation", "register", "localhost", cmd.Target.Port); err != nil {
		t.Fatal(err)
	}
	if m.Policy().Enabled || len(m.Policy().Ports) != 0 {
		t.Fatal("Agent changed permanent manual policy")
	}
	lease, err := m.Create(ctx, "peer", 1, cmd)
	if err != nil {
		t.Fatal(err)
	}
	conn := connect(t, m, "peer", lease)
	other := cmd
	other.RequestID = "other"
	other.ConversationID = "other"
	if _, err := m.Create(ctx, "peer", 1, other); err == nil {
		t.Fatal("one conversation's registration exposed another conversation")
	}
	if _, err := m.Agent(ctx, 2, "conversation", "register", "localhost", cmd.Target.Port); err == nil {
		t.Fatal("foreign scope registered a service")
	}
	if _, err := m.Agent(ctx, 1, "conversation", "register", "192.168.1.2", cmd.Target.Port); err == nil {
		t.Fatal("registered a LAN address")
	}
	reopened := New(m.path, func() bool { return true }, m.check, nil)
	defer reopened.Revoke()
	if len(reopened.AgentPorts()) != 0 {
		t.Fatal("temporary registration survived daemon restart")
	}
	if _, err := m.Agent(ctx, 1, "conversation", "remove", "localhost", cmd.Target.Port); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("removed Agent registration left its stream open")
	}
	if _, err := m.change("peer", 1, lease.ID, true); err == nil {
		t.Fatal("revoked registration retained its grant")
	}
}

func TestAgentPrepareAndStoppedServiceCleanup(t *testing.T) {
	m, cmd := fixture(t)
	ctx := context.Background()
	if err := m.SetPolicy(Policy{Ports: []int{}}); err != nil {
		t.Fatal(err)
	}
	if err := m.Prepare(ctx, 1, "conversation", "https://example.com/"); err != nil || len(m.AgentPorts()) != 0 {
		t.Fatalf("public URL registered: %v", err)
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer origin.Close()
	_, rawPort, _ := net.SplitHostPort(origin.Listener.Addr().String())
	port, _ := strconv.Atoi(rawPort)
	if err := m.Prepare(ctx, 1, "conversation", fmt.Sprintf("http://localhost:%d/", port)); err != nil {
		t.Fatal(err)
	}
	cmd.Target.Port = port
	lease, err := m.Create(ctx, "peer", 1, cmd)
	if err != nil {
		t.Fatal(err)
	}
	origin.Close()
	deadline := time.Now().Add(9 * time.Second)
	for len(m.AgentPorts()) > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if len(m.AgentPorts()) != 0 {
		t.Fatal("stopped service remained registered")
	}
	if _, err := m.change("peer", 1, lease.ID, true); err == nil {
		t.Fatal("stopped service retained a grant")
	}
	if _, err := m.Agent(ctx, 1, "conversation", "register", "localhost", port); err == nil {
		t.Fatal("unready service registered")
	}
}

func TestAgentRevocationPreservesManualPortsAndExplicitShutdownClearsAll(t *testing.T) {
	m, cmd := fixture(t)
	ctx := context.Background()
	if _, err := m.Agent(ctx, 1, "conversation", "register", "localhost", cmd.Target.Port); err != nil {
		t.Fatal(err)
	}
	lease, err := m.Create(ctx, "peer", 1, cmd)
	if err != nil {
		t.Fatal(err)
	}
	m.ClearAgentPorts()
	if len(m.AgentPorts()) != 0 || !m.Policy().Enabled || len(m.Policy().Ports) != 1 {
		t.Fatal("clearing Agent ports changed manual policy")
	}
	if _, err := m.change("peer", 1, lease.ID, true); err != nil {
		t.Fatalf("manual grant was revoked: %v", err)
	}
	if _, err := m.Agent(ctx, 1, "conversation", "register", "localhost", cmd.Target.Port); err != nil {
		t.Fatal(err)
	}
	if err := m.SetPolicy(Policy{Ports: []int{}}); err != nil {
		t.Fatal(err)
	}
	if len(m.AgentPorts()) != 0 {
		t.Fatal("explicit shutdown left Agent registrations active")
	}
}
