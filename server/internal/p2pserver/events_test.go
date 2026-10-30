package p2pserver

import (
	"bufio"
	"context"
	"net/http"
	"testing"
	"time"
)

func TestDeviceEventsAreAuthenticatedScopedAndRemovedOnDisconnect(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.raw(t, http.MethodGet, "/v1/events", "invalid", nil); code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated watch = %d", code)
	}
	type subscription struct {
		cancel context.CancelFunc
		events chan string
	}
	watch := func(token string) subscription {
		ctx, cancel := context.WithCancel(context.Background())
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, h.http.URL+"/v1/events", nil)
		req.Header.Set("Authorization", "Bearer "+h.session(t, token))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		events := make(chan string, 8)
		go func() {
			defer res.Body.Close()
			defer close(events)
			scanner := bufio.NewScanner(res.Body)
			for scanner.Scan() {
				if line := scanner.Text(); line == "event: ready" || line == "event: devices.changed" {
					events <- line
				}
			}
		}()
		t.Cleanup(cancel)
		select {
		case event := <-events:
			if event != "event: ready" {
				t.Fatal(event)
			}
		case <-time.After(time.Second):
			t.Fatal("watch not ready")
		}
		return subscription{cancel, events}
	}
	alice, bob := watch("tok-alice"), watch("tok-bob")
	key, _ := newKey(t)
	if code, _ := h.do(t, http.MethodPost, "/v1/devices", "tok-alice", registerRequest{DaemonID: "a", PublicKey: key}); code != http.StatusOK {
		t.Fatal(code)
	}
	select {
	case <-alice.events:
	case <-time.After(time.Second):
		t.Fatal("registration not pushed")
	}
	select {
	case event := <-bob.events:
		t.Fatalf("cross-account event %q", event)
	case <-time.After(100 * time.Millisecond):
	}
	if code, _ := h.do(t, http.MethodDelete, "/v1/devices?daemon_id=a", "tok-alice", nil); code != http.StatusNoContent {
		t.Fatal(code)
	}
	select {
	case <-alice.events:
	case <-time.After(time.Second):
		t.Fatal("removal not pushed")
	}
	alice.cancel()
	bob.cancel()
	for _, sub := range []subscription{alice, bob} {
		select {
		case <-sub.events:
		case <-time.After(time.Second):
			t.Fatal("watch did not stop")
		}
	}
	deadline := time.Now().Add(time.Second)
	for {
		h.srv.watchMu.Lock()
		count := len(h.srv.watchers)
		h.srv.watchMu.Unlock()
		if count == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("watch subscriptions leaked")
		}
		time.Sleep(time.Millisecond)
	}
}
