package localhost

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// protocolFixtures maps each shared fixture to the Go type that produces or
// consumes it. The TypeScript side decodes the same files with its schemas.
var protocolFixtures = map[string]func() any{
	"desktop-to-daemon/session.set.params":     func() any { return &SessionParams{} },
	"desktop-to-daemon/session.set.result":     func() any { return &SessionResult{} },
	"desktop-to-daemon/subscribe.params":       func() any { return &SubscribeParams{} },
	"desktop-to-daemon/subscribe.result":       func() any { return &SubscribeResult{} },
	"desktop-to-daemon/request.params":         func() any { return &RequestParams{} },
	"desktop-to-daemon/hostReply.params":       func() any { return &HostReplyParams{} },
	"desktop-to-daemon/hostReply.error.params": func() any { return &HostReplyParams{} },
	"desktop-to-daemon/sidecar.drain.result":   func() any { return &DrainResult{} },
	"daemon-to-desktop/event":                  func() any { return &EventNotification{} },
	"daemon-to-desktop/hostRequest":            func() any { return &HostRequestNotification{} },
	"daemon-to-desktop/hostRequestResolved":    func() any { return &HostRequestResolvedNotification{} },
	"daemon-to-desktop/sidecarStatus":          func() any { return &SidecarStatusNotification{} },
	"daemon-to-desktop/resync":                 func() any { return &ResyncNotification{} },
	"daemon-to-sidecar/init.params":            func() any { return &InitParams{} },
	"daemon-to-sidecar/session.set.params":     func() any { return &SidecarSessionParams{} },
	"daemon-to-sidecar/request.params":         func() any { return &SidecarRequestParams{} },
	"daemon-to-sidecar/drain.result":           func() any { return &DrainResult{} },
	"daemon-to-sidecar/file.resolve.params":    func() any { return &FileResolveParams{} },
	"daemon-to-sidecar/file.resolve.result":    func() any { return &FileResolveResult{} },
	"daemon-to-sidecar/file.commit.params":     func() any { return &FileCommitParams{} },
	"daemon-to-sidecar/file.commit.result":     func() any { return &FileCommitResult{} },
	"sidecar-to-daemon/event.params":           func() any { return &SidecarEventParams{} },
	"sidecar-to-daemon/busy.params":            func() any { return &BusyParams{} },
	"sidecar-to-daemon/log.params":             func() any { return &LogParams{} },
	"sidecar-to-daemon/host.request.params":    func() any { return &HostRequestParams{} },
}

// TestProtocolFixturesMatchWireTypes fails when a Go wire type gains, loses
// or renames a field without the shared fixture (and so the TypeScript
// schemas) changing with it.
func TestProtocolFixturesMatchWireTypes(t *testing.T) {
	root := filepath.Join("testdata", "protocol")
	seen := map[string]bool{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		name := filepath.ToSlash(strings.TrimSuffix(strings.TrimPrefix(path, root+string(filepath.Separator)), ".json"))
		seen[name] = true
		newValue, ok := protocolFixtures[name]
		if !ok {
			t.Errorf("fixture %s has no Go wire type", name)
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		value := newValue()
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(value); err != nil {
			t.Errorf("%s: %v", name, err)
			return nil
		}
		encoded, _ := json.Marshal(value)
		var want, got any
		_ = json.Unmarshal(raw, &want)
		_ = json.Unmarshal(encoded, &got)
		if !reflect.DeepEqual(want, got) {
			t.Errorf("%s does not round-trip:\nfixture %s\nencoded %s", name, raw, encoded)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for name := range protocolFixtures {
		if !seen[name] {
			t.Errorf("missing fixture %s.json", name)
		}
	}
}
