package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// Settings calls use the execution-local MCP registry, not a second set of
// REST operations or the user's ambient CLI profile.
var settingsCmd = &cobra.Command{Use: "settings", Short: "Use Multica Desktop's execution-scoped Settings capabilities"}
var settingsCapabilitiesCmd = &cobra.Command{
	Use: "capabilities", Short: "List available Settings capabilities and their scope",
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		return callSettingsTool(cmd, "settings_capabilities", map[string]any{})
	},
}
var settingsCallCmd = &cobra.Command{
	Use: "call <settings_tool_name>", Short: "Call a Settings operation with JSON input from a file or stdin",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !regexp.MustCompile(`^settings_[a-z_]+$`).MatchString(args[0]) {
			return errors.New("only settings_ tools may be called through this adapter")
		}
		path, _ := cmd.Flags().GetString("input-file")
		input := map[string]any{}
		if path != "" {
			var reader io.Reader = cmd.InOrStdin()
			if path != "-" {
				file, err := os.Open(path)
				if err != nil {
					return err
				}
				defer file.Close()
				reader = file
			}
			data, err := io.ReadAll(io.LimitReader(reader, 1_048_577))
			if err != nil {
				return err
			}
			if len(data) > 1_048_576 {
				return errors.New("Settings input exceeds 1 MiB")
			}
			if err := json.Unmarshal(data, &input); err != nil || input == nil {
				return errors.New("Settings input must be a JSON object")
			}
		}
		return callSettingsTool(cmd, args[0], input)
	},
}
var settingsToolsCmd = &cobra.Command{
	Use: "tools", Short: "Read Settings tool schemas from the same MCP registry",
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		client, err := settingsClientFromEnv()
		if err != nil {
			return err
		}
		result, err := client.rpc(cmd.Context(), "tools/list", map[string]any{})
		if err != nil {
			return err
		}
		var list struct {
			Tools []struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				InputSchema json.RawMessage `json:"inputSchema"`
			} `json:"tools"`
		}
		if err := json.Unmarshal(result, &list); err != nil {
			return errors.New("invalid Settings tool catalog")
		}
		tools := list.Tools[:0]
		for _, tool := range list.Tools {
			if len(tool.Name) > 9 && tool.Name[:9] == "settings_" {
				tools = append(tools, tool)
			}
		}
		return writeSettingsJSON(cmd, tools)
	},
}

func init() {
	settingsCallCmd.Flags().String("input-file", "", "JSON input file; use - for stdin. Write operations require a stable request_id.")
	settingsCmd.AddCommand(settingsCapabilitiesCmd, settingsCallCmd, settingsToolsCmd)
}

type settingsMCPClient struct {
	endpoint, token string
	http            *http.Client
}

func newSettingsMCPClient(endpoint, token string) (*settingsMCPClient, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Path != "/mcp" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || token == "" {
		return nil, errors.New("Settings requires an active Multica Desktop execution; no ambient profile or remote endpoint will be used")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &settingsMCPClient{endpoint: endpoint, token: token, http: &http.Client{Transport: transport, Timeout: 5 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func settingsClientFromEnv() (*settingsMCPClient, error) {
	endpoint, token := os.Getenv("MULTICA_SETTINGS_MCP_URL"), os.Getenv("MULTICA_CONTEXT_MCP_TOKEN")
	if endpoint != "" || token != "" {
		return newSettingsMCPClient(endpoint, token)
	}
	// Provider shell filters may drop MCP environment variables. Only the
	// explicitly supplied execution root is eligible, never a user profile.
	root := os.Getenv("MULTICA_TASK_CONFIG_ROOT")
	if root == "" {
		return newSettingsMCPClient("", "")
	}
	file, err := os.Open(filepath.Join(root, "mcp.json"))
	if err != nil {
		return nil, errors.New("this execution's MCP registration is unavailable")
	}
	defer file.Close()
	var document struct {
		Servers map[string]struct {
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if err := json.NewDecoder(io.LimitReader(file, 1_048_576)).Decode(&document); err != nil {
		return nil, errors.New("this execution's MCP registration is invalid")
	}
	server := document.Servers["multica_desktop_context"]
	authorization := server.Headers["Authorization"]
	if !strings.HasPrefix(authorization, "Bearer ") {
		return nil, errors.New("this execution's MCP token is unavailable")
	}
	return newSettingsMCPClient(server.URL, strings.TrimPrefix(authorization, "Bearer "))
}

func (client *settingsMCPClient) rpc(ctx context.Context, method string, params any) (json.RawMessage, error) {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, client.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("invalid Settings request")
	}
	req.Header.Set("Authorization", "Bearer "+client.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-03-26")
	resp, err := client.http.Do(req)
	if err != nil {
		return nil, errors.New("could not reach this execution's Settings MCP; the operation outcome is not confirmed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Settings MCP returned HTTP %d; no successful operation is confirmed", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8_388_609))
	if err != nil {
		return nil, errors.New("could not read Settings result")
	}
	if len(data) > 8_388_608 {
		return nil, errors.New("Settings response exceeds 8 MiB")
	}
	var envelope struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.ID != 1 {
		return nil, errors.New("invalid Settings MCP response")
	}
	if envelope.Error != nil {
		return nil, fmt.Errorf("Settings MCP error %d", envelope.Error.Code)
	}
	if len(envelope.Result) == 0 {
		return nil, errors.New("Settings MCP did not confirm a result")
	}
	return envelope.Result, nil
}

func callSettingsTool(cmd *cobra.Command, name string, input map[string]any) error {
	client, err := settingsClientFromEnv()
	if err != nil {
		return err
	}
	result, err := client.rpc(cmd.Context(), "tools/call", map[string]any{"name": name, "arguments": input})
	if err != nil {
		return err
	}
	var reply struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(result, &reply) != nil || len(reply.Content) != 1 || reply.Content[0].Type != "text" {
		return errors.New("invalid Settings tool result")
	}
	var value any
	if json.Unmarshal([]byte(reply.Content[0].Text), &value) != nil {
		value = reply.Content[0].Text
	}
	if err := writeSettingsJSON(cmd, value); err != nil {
		return err
	}
	if reply.IsError {
		return errors.New("Settings operation failed; inspect the structured result before retrying")
	}
	return nil
}

func writeSettingsJSON(cmd *cobra.Command, value any) error {
	encoder := json.NewEncoder(cmd.OutOrStdout())
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
