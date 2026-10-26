package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/multica-ai/multica/server/pkg/agent"
)

var ErrChatModelOverride = errors.New("invalid chat model override")

// DirectChatSendOptions applies only to the input task created by this send.
// A nil Model preserves the existing Agent -> daemon -> provider defaults.
type DirectChatSendOptions struct {
	Model         *string
	InvokedAgents bool
}

// ParseChatModelOverride distinguishes an omitted field from explicit invalid
// input, including JSON null. It is shared by the HTTP and durable task paths.
func ParseChatModelOverride(raw json.RawMessage) (*string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var model string
	if err := json.Unmarshal(raw, &model); err != nil {
		return nil, fmt.Errorf("%w: model must be a string", ErrChatModelOverride)
	}
	if strings.ContainsFunc(model, unicode.IsControl) {
		return nil, fmt.Errorf("%w: model must not contain control characters", ErrChatModelOverride)
	}
	model = strings.TrimSpace(model)
	if model == "" || len(model) > 256 {
		return nil, fmt.Errorf("%w: model must contain 1 to 256 bytes", ErrChatModelOverride)
	}
	return &model, nil
}

func ValidateChatModelOverride(provider, model string) error {
	// Qoder Cloud takes its model from its remote Agent, just as its existing
	// Agent create/update validation requires; local Qoder supports overrides.
	if provider == "qoder_cloud" || !agent.ModelSelectionSupported(provider) {
		return fmt.Errorf("%w: runtime manages its own model", ErrChatModelOverride)
	}
	if agent.ModelKnownIncompatibleWithProvider(provider, model) {
		return fmt.Errorf("%w: model does not belong to this runtime provider", ErrChatModelOverride)
	}
	return nil
}

// ChatTaskModelOverride reads only the reserved direct-chat context key. Other
// task context remains independent, and retries inherit the same durable value.
func ChatTaskModelOverride(context []byte) (*string, error) {
	if len(context) == 0 {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(context, &fields); err != nil {
		return nil, fmt.Errorf("%w: invalid task context", ErrChatModelOverride)
	}
	return ParseChatModelOverride(fields["chat_model_override"])
}

func directChatModelContext(options DirectChatSendOptions) ([]byte, error) {
	if options.Model == nil {
		return nil, nil
	}
	// Marshal a typed field so callers outside HTTP cannot persist invalid
	// overrides that would later silently fall back to the Agent default.
	raw, err := json.Marshal(*options.Model)
	if err != nil {
		return nil, err
	}
	model, err := ParseChatModelOverride(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Model string `json:"chat_model_override"`
	}{Model: *model})
}
