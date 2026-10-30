package p2p

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestHTTPOverDeviceStreams(t *testing.T) {
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	acct := &testAccount{}
	acct.set(Peer{ID: idA, DeviceName: "a"}, Peer{ID: idB, DeviceName: "b"})
	a := startDevice(t, keyA, acct, "")
	b := startDevice(t, keyB, acct, "")
	const proto = "/multica/test-http/1"

	ln, stop := b.Listen(proto)
	defer stop()
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			from, _ := r.Context().Value(remoteKey{}).(string)
			body, _ := io.ReadAll(r.Body)
			_, _ = io.WriteString(w, from+" "+r.URL.Path+" "+string(body))
		}),
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			id, _ := PeerOf(c)
			return context.WithValue(ctx, remoteKey{}, id.String())
		},
	}
	go srv.Serve(ln)
	defer srv.Close()
	introduce(a, b)

	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return a.Dial(ctx, idB, proto)
	}}}
	for i := 0; i < 3; i++ {
		res, err := client.Post("http://device/x", "text/plain", strings.NewReader("hi"))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if string(body) != idA.String()+" /x hi" {
			t.Fatalf("response = %q", body)
		}
	}
	if !a.SupportsProtocol(idB, proto) {
		t.Error("b's protocol was not announced to a")
	}
	if p, ok := a.Peer(idB); !ok || p.DeviceName != "b" {
		t.Errorf("peer = %+v %v", p, ok)
	}

	stop()
	if _, err := client.Post("http://device/y", "text/plain", strings.NewReader("hi")); err == nil {
		client.CloseIdleConnections()
		if _, err := client.Post("http://device/y", "text/plain", strings.NewReader("hi")); err == nil {
			t.Fatal("request after stop succeeded")
		}
	}
}

type remoteKey struct{}

func TestDialRejectsPeerOutsideAccount(t *testing.T) {
	keyA, idA := newKey(t)
	_, stranger := newKey(t)
	acct := &testAccount{}
	acct.set(Peer{ID: idA})
	a := startDevice(t, keyA, acct, "")
	if _, err := a.Dial(context.Background(), stranger, "/multica/test-http/1"); err != ErrNotAllowed {
		t.Fatalf("dial stranger = %v", err)
	}
}
