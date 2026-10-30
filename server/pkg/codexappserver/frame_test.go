package codexappserver

import "testing"

func TestParseFrame(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		line   string
		ok     bool
		kind   FrameKind
		id     int
		method string
	}{
		{name: "result", line: `{"jsonrpc":"2.0","id":3,"result":{}}`, ok: true, kind: FrameResponse, id: 3},
		{name: "error", line: `{"jsonrpc":"2.0","id":4,"error":{"code":1}}`, ok: true, kind: FrameResponse, id: 4},
		{name: "null error still a response", line: `{"id":5,"error":null}`, ok: true, kind: FrameResponse, id: 5},
		{name: "server request", line: `{"id":9,"method":"item/commandExecution/requestApproval","params":{}}`, ok: true, kind: FrameServerRequest, id: 9, method: "item/commandExecution/requestApproval"},
		{name: "notification", line: `{"method":"turn/started","params":{"turn":{}}}`, ok: true, kind: FrameNotification, method: "turn/started"},
		{name: "non-numeric response id", line: `{"id":"x","result":{}}`},
		{name: "id without method or result", line: `{"id":1}`},
		{name: "not an object", line: `[1,2]`},
		{name: "not JSON", line: `{"id":1,`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			frame, ok := ParseFrame([]byte(tt.line))
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if !ok {
				return
			}
			if frame.Kind != tt.kind || frame.ID != tt.id || frame.Method != tt.method {
				t.Fatalf("frame = %+v, want kind=%v id=%d method=%q", frame, tt.kind, tt.id, tt.method)
			}
		})
	}
}

func TestParseFrameKeepsParamsAbsence(t *testing.T) {
	t.Parallel()

	frame, ok := ParseFrame([]byte(`{"method":"thread/closed"}`))
	if !ok || frame.Params != nil {
		t.Fatalf("frame = %+v, %v; want nil params", frame, ok)
	}
}
