package daemon

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestWatchNetworkDetectsChangesWithoutRepeatingOrTreatingReadErrorsAsChanges(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time)
	reads := make(chan int, 8)
	finished := make(chan struct{})
	var changes atomic.Int32
	go func() {
		defer close(finished)
		i := 0
		watchNetwork(ctx, ticks, func() (string, error) {
			defer func() { reads <- i; i++ }()
			switch i {
			case 0, 1:
				return "wifi", nil
			case 2:
				return "", errors.New("transient OS error")
			case 3:
				return "hotspot", nil
			default:
				return "hotspot", nil
			}
		}, func() { changes.Add(1) })
	}()
	<-reads
	for range 4 {
		ticks <- time.Now()
		<-reads
	}
	cancel()
	<-finished
	if changes.Load() != 1 {
		t.Fatalf("changes = %d", changes.Load())
	}
}

func TestRegistryWatchRenewsSessionAndRefreshesOnReadyAndInvalidation(t *testing.T) {
	var requests, refreshes atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/sessions" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"session_token":"fresh","expires_at":"2099-01-01T00:00:00Z"}`))
			return
		}
		requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer fresh" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: ready\ndata: {}\n\nevent: devices.changed\ndata: {}\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	c := newP2PRegistryClient(srv.URL, func() string { return "login-token" })
	c.session, c.expires = "old", time.Now().Add(time.Hour)
	err := c.watch(ctx, func() error {
		if refreshes.Add(1) == 2 {
			cancel()
		}
		return nil
	})
	if ctx.Err() == nil || err == nil || requests.Load() != 2 || refreshes.Load() != 2 {
		t.Fatalf("watch: err=%v requests=%d refreshes=%d", err, requests.Load(), refreshes.Load())
	}
}

func TestRegistryNetworkChangeCancelsOldRequestAndAllowsFreshRegistration(t *testing.T) {
	started := make(chan struct{})
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/sessions" {
			w.Write([]byte(`{"session_token":"session","expires_at":"2099-01-01T00:00:00Z"}`))
			return
		}
		io.Copy(io.Discard, r.Body)
		if requests.Add(1) == 1 {
			close(started)
			<-r.Context().Done()
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := newP2PRegistryClient(srv.URL, func() string { return "token" })
	finished := make(chan error, 1)
	go func() { finished <- c.register(context.Background(), "device", "", "key", "name", nil) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("old request not started")
	}
	c.networkChanged()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("old-network request succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("old-network request was not canceled promptly")
	}
	if err := c.register(context.Background(), "device", "", "key", "name", nil); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatalf("requests = %d", requests.Load())
	}
}
