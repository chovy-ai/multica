package p2pserver

import (
	"net/http"
	"time"
)

// watchDevices sends invalidations, never device data. The list endpoint remains
// authoritative, including after a dropped stream or a registry restart.
func (s *Server) watchDevices(w http.ResponseWriter, r *http.Request, userID string) {
	updates := make(chan struct{}, 1)
	s.watchMu.Lock()
	if s.watchers == nil {
		s.watchers = make(map[string]map[chan struct{}]struct{})
	}
	if s.watchers[userID] == nil {
		s.watchers[userID] = make(map[chan struct{}]struct{})
	}
	s.watchers[userID][updates] = struct{}{}
	s.watchMu.Unlock()
	defer func() {
		s.watchMu.Lock()
		delete(s.watchers[userID], updates)
		if len(s.watchers[userID]) == 0 {
			delete(s.watchers, userID)
		}
		s.watchMu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	send := func(event string) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := w.Write([]byte("event: " + event + "\ndata: {}\n\n")); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	// Subscribe before ready so a registration cannot fall between the list
	// refresh and the event subscription. Rotate to recheck session validity.
	if !send("ready") {
		return
	}
	defer rc.SetWriteDeadline(time.Time{})
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-timer.C:
			return
		case <-updates:
			if !send("devices.changed") {
				return
			}
		}
	}
}

func (s *Server) devicesChanged(userID string) {
	s.watchMu.Lock()
	defer s.watchMu.Unlock()
	for updates := range s.watchers[userID] {
		select {
		case updates <- struct{}{}:
		default:
		}
	}
}
