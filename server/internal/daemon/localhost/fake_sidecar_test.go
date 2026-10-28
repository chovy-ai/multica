package localhost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

const fakeSidecarEnv = "LOCALHOST_FAKE_SIDECAR"

// TestFakeSidecarProcess is not a test: the supervisor re-executes the test
// binary with fakeSidecarEnv set so it can act as a sidecar speaking the real
// stdio protocol without Electron or provider CLIs.
func TestFakeSidecarProcess(t *testing.T) {
	if os.Getenv(fakeSidecarEnv) != "1" {
		t.Skip("helper process")
	}
	runFakeSidecar()
	os.Exit(0)
}

func fakeSidecarCommand() Command {
	return Command{Path: os.Args[0], Args: []string{"-test.run=^TestFakeSidecarProcess$"}, Env: append(os.Environ(), fakeSidecarEnv+"=1")}
}

func runFakeSidecar() {
	var (
		conn    *Conn
		seq     atomic.Uint64
		busy    atomic.Int64
		mu      sync.Mutex
		dataDir string
	)
	stopped := make(chan struct{})
	var stopOnce sync.Once
	conn = NewConn(newLineTransport(os.Stdin, os.Stdout, nil), func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		switch method {
		case "init":
			var p InitParams
			_ = json.Unmarshal(params, &p)
			mu.Lock()
			dataDir = p.DataDir
			mu.Unlock()
			return map[string]any{}, nil
		case "session.set", "undrain":
			return map[string]any{}, nil
		case "drain":
			return map[string]any{"busy": busy.Load()}, nil
		case "shutdown":
			stopOnce.Do(func() { close(stopped) })
			return map[string]any{}, nil
		case "file.resolve":
			var p struct {
				FileRef string `json:"fileRef"`
			}
			_ = json.Unmarshal(params, &p)
			mu.Lock()
			defer mu.Unlock()
			if filepath.Base(p.FileRef) != p.FileRef {
				return nil, AppError("invalid_file", "invalid file reference")
			}
			return map[string]any{"path": filepath.Join(dataDir, "files", p.FileRef), "mimeType": "text/plain", "name": "notes.txt"}, nil
		case "file.commit":
			var p struct {
				TempPath string `json:"tempPath"`
				Name     string `json:"name"`
			}
			_ = json.Unmarshal(params, &p)
			mu.Lock()
			defer mu.Unlock()
			_ = os.MkdirAll(filepath.Join(dataDir, "files"), 0o700)
			if err := os.Rename(p.TempPath, filepath.Join(dataDir, "files", "stored-"+p.Name)); err != nil {
				return nil, err
			}
			return map[string]any{"id": "stored-" + p.Name}, nil
		case "request":
			var p struct {
				ConnectionID string          `json:"connectionId"`
				Method       string          `json:"method"`
				Params       json.RawMessage `json:"params"`
			}
			_ = json.Unmarshal(params, &p)
			switch p.Method {
			case "echo":
				return map[string]any{"connectionId": p.ConnectionID, "params": p.Params}, nil
			case "emit":
				var n int
				_ = json.Unmarshal(p.Params, &n)
				for i := 0; i < n; i++ {
					_ = conn.Notify("event", map[string]any{"seq": seq.Add(1), "event": map[string]any{"type": "changed", "sessionId": "s1"}})
				}
				return map[string]any{"last": seq.Load()}, nil
			case "work":
				var n int64
				_ = json.Unmarshal(p.Params, &n)
				busy.Store(n)
				_ = conn.Notify("busy", map[string]any{"count": n})
				return map[string]any{}, nil
			case "ask":
				var out json.RawMessage
				err := conn.Call(ctx, "host.request", map[string]any{"connectionId": p.ConnectionID, "kind": "confirmed_operation", "payload": p.Params}, &out)
				if err != nil {
					return nil, err
				}
				return out, nil
			case "crash":
				os.Exit(3)
			}
			return nil, errors.New("unknown fake method " + p.Method)
		}
		return nil, &RPCError{Code: rpcMethodNotFound, Message: method}
	})
	select {
	case <-conn.Done():
	case <-stopped:
	}
}
