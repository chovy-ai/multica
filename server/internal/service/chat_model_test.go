package service

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestParseChatModelOverride(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want string
		bad  bool
	}{
		{name: "omitted"},
		{name: "explicit", raw: `"gpt-test-model"`, want: "gpt-test-model"},
		{name: "trim", raw: `"  custom/provider-model  "`, want: "custom/provider-model"},
		{name: "null", raw: `null`, bad: true},
		{name: "empty", raw: `""`, bad: true},
		{name: "whitespace", raw: `"   "`, bad: true},
		{name: "number", raw: `42`, bad: true},
		{name: "boolean", raw: `true`, bad: true},
		{name: "object", raw: `{}`, bad: true},
		{name: "array", raw: `[]`, bad: true},
		{name: "control", raw: `"gpt-test\n"`, bad: true},
		{name: "too long", raw: `"` + strings.Repeat("x", 257) + `"`, bad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseChatModelOverride(json.RawMessage(tc.raw))
			if tc.bad {
				if !errors.Is(err, ErrChatModelOverride) {
					t.Fatalf("error = %v, want invalid override", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.raw == "" {
				if got != nil {
					t.Fatalf("omitted model = %v, want nil", got)
				}
			} else if got == nil || *got != tc.want {
				t.Fatalf("model = %v, want %q", got, tc.want)
			}
		})
	}
}

func TestChatTaskModelOverrideIsReservedAndStrict(t *testing.T) {
	for _, raw := range []string{"", "null", `{}`, `{"model":"unrelated","type":"existing_context"}`} {
		model, err := ChatTaskModelOverride([]byte(raw))
		if err != nil || model != nil {
			t.Fatalf("legacy context %q: model=%v err=%v", raw, model, err)
		}
	}
	for _, raw := range []string{`{"chat_model_override":null}`, `{"chat_model_override":123}`, `{"chat_model_override":""}`, `[]`, `{`} {
		if _, err := ChatTaskModelOverride([]byte(raw)); !errors.Is(err, ErrChatModelOverride) {
			t.Fatalf("context %q: error=%v, want invalid override", raw, err)
		}
	}
	input := "  gpt-test-model  "
	context, err := directChatModelContext(DirectChatSendOptions{Model: &input})
	if err != nil {
		t.Fatal(err)
	}
	model, err := ChatTaskModelOverride(context)
	if err != nil || model == nil || *model != "gpt-test-model" {
		t.Fatalf("durable round trip: model=%v err=%v", model, err)
	}
}

func TestValidateChatModelOverrideUsesProviderPolicy(t *testing.T) {
	for _, tc := range []struct {
		provider string
		model    string
		bad      bool
	}{
		{provider: "codex", model: "gpt-test-model"},
		{provider: "codex", model: "custom-model"},
		{provider: "codex", model: "claude-sonnet-4-6", bad: true},
		{provider: "qwenpaw", model: "custom-model", bad: true},
		{provider: "mcode", model: "custom-model", bad: true},
		{provider: "zeroclaw", model: "custom-model", bad: true},
		{provider: "qoder_cloud", model: "custom-model", bad: true},
	} {
		err := ValidateChatModelOverride(tc.provider, tc.model)
		if errors.Is(err, ErrChatModelOverride) != tc.bad {
			t.Errorf("provider=%q model=%q error=%v, want invalid=%t", tc.provider, tc.model, err, tc.bad)
		}
	}
}
