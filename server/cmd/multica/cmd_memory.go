package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/agentmemory"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var memoryCmd = newMemoryCommand()

func newMemoryCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "memory", Short: "Read and manage this agent's persistent memory"}
	cmd.PersistentFlags().String("output", "text", "Output format: text or json")
	list := &cobra.Command{Use: "list", Args: cobra.NoArgs, RunE: runMemoryList}
	list.Flags().Bool("all", false, "Include all projects")
	read := &cobra.Command{Use: "read <path>", Args: cobra.ExactArgs(1), RunE: runMemoryRead}
	search := &cobra.Command{Use: "search <query>", Args: cobra.ExactArgs(1), RunE: runMemorySearch}
	search.Flags().Int("limit", 10, "Maximum results (1–50)")
	write := &cobra.Command{Use: "write <path>", Args: cobra.ExactArgs(1), RunE: runMemoryWrite}
	write.Flags().String("title", "", "Memory title")
	write.Flags().String("description", "", "One-line description")
	write.Flags().Bool("update", false, "Update an existing entry")
	remove := &cobra.Command{Use: "delete <path>", Args: cobra.ExactArgs(1), RunE: runMemoryDelete}
	cmd.AddCommand(list, read, search, write, remove)
	return cmd
}
func memoryRequest(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	port, token := os.Getenv("MULTICA_DAEMON_PORT"), os.Getenv("MULTICA_TOKEN")
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 || token == "" {
		return nil, fmt.Errorf("multica memory is available only inside a Multica agent task")
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://127.0.0.1:"+port+"/memory/"+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var e struct {
			Error struct{ Kind, Message string }
		}
		_ = json.Unmarshal(data, &e)
		if e.Error.Message == "" {
			e.Error.Message = fmt.Sprintf("daemon returned HTTP %d", response.StatusCode)
		}
		if e.Error.Kind == "unknown_credential" {
			e.Error.Message += "; the task may have ended"
		}
		return nil, fmt.Errorf("%s", e.Error.Message)
	}
	return data, nil
}
func memoryCall(cmd *cobra.Command, method, path string, body any) (json.RawMessage, bool, error) {
	output, _ := cmd.Flags().GetString("output")
	if output != "text" && output != "json" {
		return nil, false, fmt.Errorf("--output must be text or json")
	}
	ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Second)
	defer cancel()
	data, err := memoryRequest(ctx, method, path, body)
	if err != nil {
		return nil, false, err
	}
	if output == "json" {
		fmt.Fprintln(cmd.OutOrStdout(), string(data))
		return data, true, nil
	}
	return data, false, nil
}
func runMemoryList(cmd *cobra.Command, _ []string) error {
	all, _ := cmd.Flags().GetBool("all")
	path := "index"
	if all {
		path += "?all=1"
	}
	data, done, err := memoryCall(cmd, "GET", path, nil)
	if err != nil || done {
		return err
	}
	var out struct{ Text string }
	if err = json.Unmarshal(data, &out); err != nil {
		return err
	}
	fmt.Fprint(cmd.OutOrStdout(), out.Text)
	return nil
}
func runMemoryRead(cmd *cobra.Command, args []string) error {
	data, done, err := memoryCall(cmd, "GET", "entry?path="+url.QueryEscape(args[0]), nil)
	if err != nil || done {
		return err
	}
	var out struct{ Entry agentmemory.Entry }
	if err = json.Unmarshal(data, &out); err != nil {
		return err
	}
	text, err := agentmemory.FormatEntry(out.Entry)
	if err != nil {
		return err
	}
	fmt.Fprint(cmd.OutOrStdout(), string(text))
	return nil
}
func runMemorySearch(cmd *cobra.Command, args []string) error {
	limit, _ := cmd.Flags().GetInt("limit")
	if limit < 1 || limit > 50 {
		return fmt.Errorf("--limit must be between 1 and 50")
	}
	data, done, err := memoryCall(cmd, "GET", "search?q="+url.QueryEscape(args[0])+"&limit="+strconv.Itoa(limit), nil)
	if err != nil || done {
		return err
	}
	var out struct{ Hits []agentmemory.SearchHit }
	if err = json.Unmarshal(data, &out); err != nil {
		return err
	}
	if len(out.Hits) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No matching memory.")
	}
	for _, h := range out.Hits {
		fmt.Fprintf(cmd.OutOrStdout(), "%s — %s: %s\n", h.Path, h.Title, h.Snippet)
	}
	return nil
}
func runMemoryWrite(cmd *cobra.Command, args []string) error {
	title, _ := cmd.Flags().GetString("title")
	description, _ := cmd.Flags().GetString("description")
	if strings.TrimSpace(title) == "" || strings.TrimSpace(description) == "" {
		return fmt.Errorf("--title and --description are required")
	}
	reader := cmd.InOrStdin()
	if f, ok := reader.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		return fmt.Errorf("pipe the memory body on stdin")
	}
	body, err := io.ReadAll(io.LimitReader(reader, 8193))
	if err != nil {
		return err
	}
	if len(body) > 8192 {
		return agentmemory.ErrTooLarge
	}
	if strings.TrimSpace(string(body)) == "" {
		return fmt.Errorf("pipe the memory body on stdin")
	}
	mode := "create"
	update, _ := cmd.Flags().GetBool("update")
	if update {
		mode = "update"
	}
	data, done, err := memoryCall(cmd, "PUT", "entry", map[string]string{"path": args[0], "title": title, "description": description, "body": string(body), "mode": mode})
	if err != nil {
		return err
	}
	var out struct {
		Entry    agentmemory.Entry
		Warnings []string
	}
	if err = json.Unmarshal(data, &out); err != nil {
		return err
	}
	for _, w := range out.Warnings {
		if w == "body_over_soft_limit" {
			fmt.Fprintln(cmd.ErrOrStderr(), "warning: body is over 2KB; keep entries short")
		}
	}
	if !done {
		fmt.Fprintln(cmd.OutOrStdout(), "Saved "+out.Entry.Path)
	}
	return nil
}
func runMemoryDelete(cmd *cobra.Command, args []string) error {
	_, done, err := memoryCall(cmd, "DELETE", "entry?path="+url.QueryEscape(args[0]), nil)
	if err != nil || done {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Deleted %s (recoverable for 30 days)\n", args[0])
	return nil
}
func attachMemoryReceipt(content string, stderr io.Writer) string {
	if os.Getenv("MULTICA_DAEMON_PORT") == "" || os.Getenv("MULTICA_TOKEN") == "" {
		return content
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	data, err := memoryRequest(ctx, "POST", "receipts/claim", nil)
	var out struct{ Titles []string }
	if err == nil {
		err = json.Unmarshal(data, &out)
	}
	if err != nil {
		fmt.Fprintf(stderr, "warning: could not attach memory receipt: %v\n", err)
		return content
	}
	if len(out.Titles) == 0 {
		return content
	}
	return strings.TrimRight(content, "\n") + "\n\n已记住：" + strings.Join(out.Titles, "、")
}
