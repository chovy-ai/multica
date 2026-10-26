package main

import (
	"context"
	"fmt"
	"net/url"
	"time"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var issueContextCmd = &cobra.Command{
	Use:   "context <id>",
	Short: "Read issue details, complete comment threads, and attachment metadata as JSON",
	Long: `Read the current issue without truncating its description, metadata, labels or properties.
Includes the most recently active comment threads without folding resolved discussions.
When comments_page.has_more is true, repeat with next_before and next_before_id.
Attachment entries contain IDs; use attachment download <id> to read their actual contents.
This command only queries existing server APIs; it does not change the issue.`,
	Args: exactArgs(1),
	RunE: runIssueContext,
}

func init() {
	issueContextCmd.Flags().String("output", "json", "Output format: json")
	issueContextCmd.Flags().Int("recent", 20, "Number of recently active comment threads (1–100)")
	issueContextCmd.Flags().String("before", "", "Older thread cursor from comments_page.next_before")
	issueContextCmd.Flags().String("before-id", "", "Older thread UUID from comments_page.next_before_id")
	issueCmd.AddCommand(issueContextCmd)
}

func runIssueContext(cmd *cobra.Command, args []string) error {
	output, _ := cmd.Flags().GetString("output")
	if output != "json" {
		return fmt.Errorf("issue context supports --output json")
	}
	recent, _ := cmd.Flags().GetInt("recent")
	before, _ := cmd.Flags().GetString("before")
	beforeID, _ := cmd.Flags().GetString("before-id")
	if recent < 1 || recent > 100 {
		return fmt.Errorf("--recent must be between 1 and 100")
	}
	if (before == "") != (beforeID == "") {
		return fmt.Errorf("--before and --before-id must be set together")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	ref, err := resolveIssueRef(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve issue: %w", err)
	}
	path := "/api/issues/" + url.PathEscape(ref.ID)
	var issue map[string]any
	if err := client.GetJSON(ctx, path, &issue); err != nil {
		return fmt.Errorf("get issue context: %w", err)
	}
	if workspace := strVal(issue, "workspace_id"); client.WorkspaceID != "" && workspace != client.WorkspaceID {
		return fmt.Errorf("issue does not belong to the selected workspace")
	}
	query := url.Values{"recent": {fmt.Sprint(recent)}}
	if before != "" {
		query.Set("before", before)
		query.Set("before_id", beforeID)
	}
	// Do not request folding: context reads must include the discussion bodies.
	comments := []map[string]any{}
	headers, err := client.GetJSONWithHeaders(ctx, path+"/comments?"+query.Encode(), &comments)
	if err != nil {
		return fmt.Errorf("get issue context comments: %w", err)
	}
	nextBefore := headers.Get("X-Multica-Next-Before")
	nextID := headers.Get("X-Multica-Next-Before-Id")
	if (nextBefore == "") != (nextID == "") {
		return fmt.Errorf("server returned an incomplete comment cursor; comment coverage is unknown")
	}
	attachments := []map[string]any{}
	seen := map[string]bool{}
	collect := func(row map[string]any) {
		items, _ := row["attachments"].([]any)
		for _, item := range items {
			attachment, ok := item.(map[string]any)
			if !ok {
				continue
			}
			id := strVal(attachment, "id")
			if id != "" && !seen[id] {
				seen[id] = true
				attachments = append(attachments, attachment)
			}
		}
	}
	collect(issue)
	for _, comment := range comments {
		collect(comment)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
		"issue": issue, "comments": comments, "attachments": attachments,
		"retrieved_at": time.Now().UTC().Format(time.RFC3339),
		"comments_page": map[string]any{
			"recent": recent, "has_more": nextBefore != "", "next_before": nextBefore, "next_before_id": nextID,
			"truncated": headers.Get("X-Comments-Truncated") == "true",
		},
	})
}
