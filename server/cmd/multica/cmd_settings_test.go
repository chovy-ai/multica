package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsAdapterUsesOnlyTheExplicitExecutionRegistration(t *testing.T) {
	t.Setenv("MULTICA_SETTINGS_MCP_URL", "")
	t.Setenv("MULTICA_CONTEXT_MCP_TOKEN", "")
	root := t.TempDir()
	t.Setenv("MULTICA_TASK_CONFIG_ROOT", root)
	data := `{"mcpServers":{"multica_desktop_context":{"url":"http://127.0.0.1:1234/mcp","headers":{"Authorization":"Bearer test-private"}},"external":{"url":"https://example.invalid/mcp"}}}`
	if err := os.WriteFile(filepath.Join(root, "mcp.json"), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := settingsClientFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if client.endpoint != "http://127.0.0.1:1234/mcp" || client.token != "test-private" {
		t.Fatal("did not use the execution registration")
	}
	t.Setenv("MULTICA_SETTINGS_MCP_URL", "http://127.0.0.1:4321/mcp")
	if _, err := settingsClientFromEnv(); err == nil {
		t.Fatal("mixed partial environment and file credentials")
	}
	t.Setenv("MULTICA_SETTINGS_MCP_URL", "")
	t.Setenv("MULTICA_TASK_CONFIG_ROOT", "")
	if _, err := settingsClientFromEnv(); err == nil {
		t.Fatal("fell back to an ambient profile")
	}
}

func TestSettingsAdapterRejectsRemoteEndpointsAndMissingExecutionTokens(t *testing.T) {
	for _, endpoint := range []string{"", "https://example.com/mcp", "http://localhost:1234/mcp", "http://127.0.0.1:1234/other", "http://user:password@127.0.0.1:1234/mcp", "http://127.0.0.1:1234/mcp?token=x", "http://127.0.0.1:1234/mcp#fragment"} {
		if _, err := newSettingsMCPClient(endpoint, "test-token"); err == nil {
			t.Errorf("accepted endpoint %q", endpoint)
		}
	}
	if _, err := newSettingsMCPClient("http://127.0.0.1:1234/mcp", ""); err == nil {
		t.Fatal("accepted missing token")
	}
}

func TestSettingsAdapterCallsTheExecutionMCPWithoutAmbientProfiles(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-execution-token" {
			t.Error("missing execution token")
		}
		if r.Header.Get("MCP-Protocol-Version") != "2025-03-26" {
			t.Error("missing MCP protocol version")
		}
		var payload struct {
			Method string `json:"method"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload.Method != "tools/call" || payload.Params.Name != "settings_create_workflow" || payload.Params.Arguments["request_id"] != "same-operation" {
			t.Error("incorrect MCP operation")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"status\":\"applied\"}"}]}}`))
	}))
	defer server.Close()
	client, err := newSettingsMCPClient(server.URL+"/mcp", "test-execution-token")
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.rpc(context.Background(), "tools/call", map[string]any{"name": "settings_create_workflow", "arguments": map[string]any{"name": "Delivery", "request_id": "same-operation"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(result), "applied") {
		t.Fatalf("result = %s", result)
	}
}

func TestSettingsAdapterNeverForwardsCredentialsOnRedirect(t *testing.T) {
	forwarded := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded = true }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client, err := newSettingsMCPClient(server.URL+"/mcp", "private-execution-token")
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.rpc(context.Background(), "tools/list", map[string]any{})
	if err == nil || forwarded {
		t.Fatal("followed a redirect with execution credentials")
	}
	if strings.Contains(err.Error(), "private-execution-token") {
		t.Fatal("error disclosed token")
	}
}

func TestSettingsAdapterRejectsUnconfirmedAndMalformedResponses(t *testing.T) {
	for _, body := range []string{`not-json`, `{"jsonrpc":"2.0","id":2,"result":{}}`, `{"jsonrpc":"2.0","id":1}`, `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"private-token"}}`} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
			defer server.Close()
			client, err := newSettingsMCPClient(server.URL+"/mcp", "private-token")
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.rpc(context.Background(), "tools/list", map[string]any{})
			if err == nil || strings.Contains(err.Error(), "private-token") {
				t.Fatalf("unsafe response handling: %v", err)
			}
		})
	}
}
