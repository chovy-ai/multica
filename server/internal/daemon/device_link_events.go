package daemon

import (
	"net/http"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/multica-ai/multica/server/internal/daemon/p2p"
)

// Served by the local authenticated entry, never forwarded to the other
// device. A ready path wakes Desktop even during its WebSocket retry delay.
func serveDeviceLinkEvents(w http.ResponseWriter, r *http.Request, svc *p2p.Service, id peer.ID) {
	updates, stop := svc.WatchConnection(id)
	defer stop()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	rc := http.NewResponseController(w)
	defer rc.SetWriteDeadline(time.Time{})
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	previous := ""
	for {
		event := "link.disconnected"
		if svc.Connection(id) != "" {
			event = "link.connected"
		}
		if event != previous {
			_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if _, err := w.Write([]byte("event: " + event + "\ndata: {}\n\n")); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
			previous = event
		}
		select {
		case <-r.Context().Done():
			return
		case <-timer.C:
			return
		case <-updates:
		}
	}
}
