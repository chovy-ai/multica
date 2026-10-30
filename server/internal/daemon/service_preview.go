package daemon

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/multica-ai/multica/server/internal/daemon/localhost"
	"github.com/multica-ai/multica/server/internal/daemon/servicepreview"
)

func (l *deviceLink) handlePreviewPolicy(w http.ResponseWriter, r *http.Request) {
	if !localhost.AuthorizeDesktop(r, l.token) {
		http.Error(w, "forbidden", 403)
		return
	}
	if r.Method == http.MethodDelete {
		l.preview.ClearAgentPorts()
	} else if r.Method == http.MethodPut {
		var policy servicepreview.Policy
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		d.DisallowUnknownFields()
		if d.Decode(&policy) != nil || d.Decode(new(any)) != io.EOF {
			deviceLinkError(w, 400, "invalid_request", "Specify enabled and allowed ports")
			return
		}
		if err := l.preview.SetPolicy(policy); err != nil {
			servicepreview.WriteError(w, err)
			return
		}
	} else if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	policy := l.preview.Policy()
	l.mu.Lock()
	available := l.svc != nil
	l.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"enabled": policy.Enabled, "ports": policy.Ports, "available": available, "agent_ports": l.preview.AgentPorts()})
}

func (l *deviceLink) handlePreviewTunnel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !localhost.AuthorizeMain(r, l.token) {
		http.Error(w, "forbidden", 403)
		return
	}
	if _, err := l.v2.PreviewScope(r); err != nil {
		deviceLinkError(w, 403, "forbidden", "This account or workspace is not active")
		return
	}
	id, err := peer.Decode(r.URL.Query().Get("device_id"))
	if err != nil {
		deviceLinkError(w, 400, "device_unknown", "Invalid target device")
		return
	}
	l.mu.Lock()
	svc := l.svc
	l.mu.Unlock()
	if svc == nil {
		deviceLinkError(w, 503, "device_unreachable", "Device link is unavailable")
		return
	}
	if !svc.SupportsProtocol(id, servicepreview.Protocol) {
		deviceLinkError(w, 409, "preview_unsupported", "This device does not support service preview")
		return
	}
	stream, err := servicepreview.Dial(r.Context(), func(ctx context.Context) (net.Conn, error) { return svc.Dial(ctx, id, servicepreview.Protocol) }, servicepreview.Hello{Version: 1, ServiceID: r.URL.Query().Get("service_id"), ConnectionID: rand.Text(), Capability: r.Header.Get("X-Multica-Preview-Capability")})
	if err != nil {
		servicepreview.WriteError(w, err)
		return
	}
	defer stream.Close()
	upgrader := websocket.Upgrader{ReadBufferSize: 32 << 10, WriteBufferSize: 32 << 10, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(64 << 10)
	var writing sync.Mutex
	write := func(kind int, value []byte) error {
		writing.Lock()
		defer writing.Unlock()
		return ws.WriteMessage(kind, value)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		half := false
		for {
			kind, value, err := ws.ReadMessage()
			if err != nil {
				_ = stream.Close()
				return
			}
			if kind == websocket.TextMessage && string(value) == `{"type":"half_close"}` && !half {
				half = true
				if c, ok := stream.(interface{ CloseWrite() error }); ok {
					_ = c.CloseWrite()
				}
				continue
			}
			if kind != websocket.BinaryMessage || half {
				_ = stream.Close()
				_ = ws.Close()
				return
			}
			if _, err := stream.Write(value); err != nil {
				_ = ws.Close()
				return
			}
		}
	}()
	buffer := make([]byte, 32<<10)
	for {
		n, err := stream.Read(buffer)
		if n > 0 {
			if write(websocket.BinaryMessage, buffer[:n]) != nil {
				return
			}
		}
		if err != nil {
			if err == io.EOF {
				if write(websocket.TextMessage, []byte(`{"type":"half_close"}`)) != nil {
					return
				}
				<-done
			}
			return
		}
	}
}
