package daemon

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/multica-ai/multica/server/internal/daemon/localhost"
	"github.com/multica-ai/multica/server/internal/daemon/p2p"
	"github.com/multica-ai/multica/server/internal/daemon/servicepreview"
	ma "github.com/multiformats/go-multiaddr"
)

func TestDeviceLinkServicePreviewControlAndNativeBridge(t *testing.T) {
	ka, ia := newLinkKey(t)
	kb, ib := newLinkKey(t)
	account := &linkAccount{peers: []p2p.Peer{{ID: ia}, {ID: ib}}}
	viewer, host := newLinkDevice(t, account, ka, "viewer-token"), newLinkDevice(t, account, kb, "host-token")
	if err := host.link.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	addresses := []ma.Multiaddr{}
	for _, a := range host.p2p.Status().ListenAddrs {
		addresses = append(addresses, ma.StringCast(a))
	}
	viewer.p2p.AddAddrs(peer.AddrInfo{ID: ib, Addrs: addresses})
	deadline := time.Now().Add(10 * time.Second)
	for !viewer.p2p.SupportsProtocol(ib, servicepreview.Protocol) {
		if time.Now().After(deadline) {
			t.Fatal("preview protocol not discovered")
		}
		time.Sleep(25 * time.Millisecond)
	}
	base := "/local/devices/" + ib.String() + "/local/v2"
	if status, body := viewer.do(t, viewer.token, "POST", base+"/sessions", map[string]any{"id": "preview-conversation", "provider": "claude"}); status != 201 {
		t.Fatalf("create: %d %v", status, body)
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = fmt.Fprint(w, "OTHER DEVICE "+r.Host+r.URL.Path) }))
	defer target.Close()
	_, rawPort, _ := net.SplitHostPort(target.Listener.Addr().String())
	port, _ := strconv.Atoi(rawPort)
	cmd := map[string]any{"version": 1, "request_id": "r", "conversation_id": "preview-conversation", "target": map[string]any{"host": "localhost", "port": port}}
	if status, _ := viewer.do(t, viewer.token, "POST", base+"/preview/services", cmd); status != 403 {
		t.Fatalf("shared conversations implicitly exposed service: %d", status)
	}
	request := httptest.NewRequest("GET", "http://localhost/", nil)
	request.Header.Set("X-Multica-API-Origin", "https://api.multica.ai")
	request.Header.Set("X-Multica-User-ID", "user-1")
	request.Header.Set("X-Workspace-ID", "ws-1")
	scope, err := host.v2.PreviewScope(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.link.preview.Agent(context.Background(), scope, "preview-conversation", "register", "localhost", port); err != nil {
		t.Fatal(err)
	}
	cmd["request_id"] = "auto"
	if status, body := viewer.do(t, viewer.token, "POST", base+"/preview/services", cmd); status != 201 {
		t.Fatalf("registered Agent service was denied over P2P: %d %v", status, body)
	}
	if host.link.preview.Policy().Enabled || len(host.link.preview.Policy().Ports) != 0 {
		t.Fatal("Agent service changed permanent policy")
	}
	if status, body := host.do(t, host.token, "DELETE", "/local/service-preview", nil); status != 200 || len(body["agent_ports"].([]any)) != 0 {
		t.Fatalf("revoke Agent ports: %d %v", status, body)
	}
	cmd["request_id"] = "after-auto-revocation"
	if status, _ := viewer.do(t, viewer.token, "POST", base+"/preview/services", cmd); status != 403 {
		t.Fatalf("revoked Agent port remained accessible: %d", status)
	}
	if status, _ := host.do(t, host.token, "PUT", "/local/service-preview", map[string]any{"enabled": true, "ports": []int{port}}); status != 200 {
		t.Fatalf("policy: %d", status)
	}
	if status, _ := viewer.do(t, localhost.RendererToken(viewer.token), "POST", base+"/preview/services", cmd); status != 403 {
		t.Fatalf("renderer minted a capability: %d", status)
	}
	status, lease := viewer.do(t, viewer.token, "POST", base+"/preview/services", cmd)
	if status != 201 {
		t.Fatalf("service creation: %d %v", status, lease)
	}
	q := url.Values{"device_id": {ib.String()}, "service_id": {lease["service_id"].(string)}}
	endpoint := strings.Replace(viewer.srv.URL, "http://", "ws://", 1) + "/local/preview/tunnel?" + q.Encode()
	headers := http.Header{"Authorization": {"Bearer " + viewer.token}, "X-Multica-API-Origin": {"https://api.multica.ai"}, "X-Multica-User-ID": {"user-1"}, "X-Workspace-ID": {"ws-1"}, "X-Multica-Preview-Capability": {lease["capability"].(string)}}
	bad := headers.Clone()
	bad.Set("Authorization", "Bearer "+localhost.RendererToken(viewer.token))
	if ws, res, err := websocket.DefaultDialer.Dial(endpoint, bad); err == nil {
		ws.Close()
		t.Fatal("renderer opened native bridge")
	} else if res == nil || res.StatusCode != 403 {
		t.Fatalf("unexpected renderer denial: %v %v", res, err)
	}
	ws, _, err := websocket.DefaultDialer.Dial(endpoint, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := ws.WriteMessage(websocket.BinaryMessage, []byte("GET /login HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	if err := ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"half_close"}`)); err != nil {
		t.Fatal(err)
	}
	var raw bytes.Buffer
	for {
		kind, data, err := ws.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind == websocket.TextMessage {
			break
		}
		raw.Write(data)
	}
	reply, err := http.ReadResponse(bufio.NewReader(&raw), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(reply.Body)
	reply.Body.Close()
	if string(body) != "OTHER DEVICE localhost:3000/login" {
		t.Fatalf("wrong device: %q", body)
	}
	if status, _ := viewer.do(t, viewer.token, "DELETE", base+"/preview/services/"+lease["service_id"].(string), nil); status != 200 {
		t.Fatalf("close service: %d", status)
	}
}
