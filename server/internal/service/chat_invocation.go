package service

import (
	"encoding/json"
	"errors"
)

var ErrChatInvocationDenied = errors.New("agent invocation not allowed")

// ChatInvocationMetadata identifies a persisted user-requested agent invocation.
type ChatInvocationMetadata struct {
	GroupID   string `json:"chat_invocation_group_id"`
	AgentName string `json:"chat_invoked_agent_name"`
}

func ChatInvocationFromContext(raw []byte) ChatInvocationMetadata {
	var value ChatInvocationMetadata
	_ = json.Unmarshal(raw, &value)
	return value
}
