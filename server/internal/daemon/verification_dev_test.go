//go:build verificationdev

package daemon

import "testing"

func TestVerificationLinksOnlyThroughLoopbackRegistry(t *testing.T) {
	for raw, want := range map[string]bool{
		"http://127.0.0.1:60750":        true,
		"http://localhost:8090":         true,
		"http://[::1]:8090":             true,
		"http://101.33.221.22:8090":     false,
		"https://p2p.example.com":       false,
		"http://127.0.0.1.example.com/": false,
		"":                              false,
	} {
		if got := loopbackRegistry(raw); got != want {
			t.Errorf("loopbackRegistry(%q) = %v, want %v", raw, got, want)
		}
	}
}
