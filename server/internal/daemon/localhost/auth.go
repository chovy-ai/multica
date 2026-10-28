package localhost

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
)

// Authorize admits only requests a local, non-browser client could make: the
// bearer token, a loopback Host (defeats DNS rebinding), and no Origin header
// (browsers send one on every cross-origin request, WebSocket included).
func Authorize(r *http.Request, token string) bool {
	if token == "" || r.Header.Get("Origin") != "" {
		return false
	}
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	switch strings.ToLower(strings.Trim(host, "[]")) {
	case "127.0.0.1", "localhost", "::1":
	default:
		return false
	}
	presented, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1
}
