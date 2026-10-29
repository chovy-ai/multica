package codexappserver

import "encoding/json"

// FrameKind classifies one line read from the app-server's stdout.
type FrameKind int

const (
	// FrameResponse answers a request this side sent.
	FrameResponse FrameKind = iota + 1
	// FrameServerRequest is a request from the app-server that needs a reply.
	FrameServerRequest
	// FrameNotification carries no id and needs no reply.
	FrameNotification
)

// Frame is one decoded JSON-RPC message.
type Frame struct {
	Kind   FrameKind
	ID     int
	Method string
	Params json.RawMessage
	Result json.RawMessage
	Error  json.RawMessage
}

// ParseFrame decodes one stdout line. It reports false for lines that are not
// JSON objects or match no JSON-RPC message shape.
func ParseFrame(line []byte) (Frame, bool) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(line, &raw); err != nil {
		return Frame{}, false
	}
	frame := Frame{Params: raw["params"], Result: raw["result"], Error: raw["error"]}
	_ = json.Unmarshal(raw["method"], &frame.Method)
	_, hasMethod := raw["method"]

	if idRaw, hasID := raw["id"]; hasID {
		_, hasResult := raw["result"]
		_, hasError := raw["error"]
		switch {
		case hasResult || hasError:
			if err := json.Unmarshal(idRaw, &frame.ID); err != nil {
				return Frame{}, false
			}
			frame.Kind = FrameResponse
			return frame, true
		case hasMethod:
			_ = json.Unmarshal(idRaw, &frame.ID)
			frame.Kind = FrameServerRequest
			return frame, true
		}
	}
	if hasMethod {
		frame.Kind = FrameNotification
		return frame, true
	}
	return Frame{}, false
}
