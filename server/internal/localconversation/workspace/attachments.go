package workspace

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

func attachmentIDs(value any) []string {
	var out []string
	switch ids := value.(type) {
	case []string:
		out = ids
	case []any:
		for _, id := range ids {
			out = append(out, id.(string))
		}
	}
	return out
}

// prepareAttachments keeps local IDs out of the cloud request and persists
// only durable Markdown references, never a temporary download capability.
func (k *toolkit) prepareAttachments(ctx context.Context, body row, textField, previous string) error {
	ids := attachmentIDs(body["attachment_ids"])
	local := attachmentIDs(body["local_attachment_ids"])
	delete(body, "local_attachment_ids")
	if len(ids)+len(local) == 0 {
		return nil
	}
	if len(ids)+len(local) > 50 {
		return errors.New("Supply at most 50 attachments in total")
	}
	metadata := map[string]row{}
	load := func(id string) error {
		if metadata[id] != nil {
			return nil
		}
		v, err := k.get(ctx, "/api/attachments/"+url.PathEscape(id))
		if err != nil {
			return err
		}
		m, err := asRow(v)
		if err != nil || m["id"] != id || m["workspace_id"] != k.opts.WorkspaceID || str(m, "markdown_url") == "" {
			return errors.New("Attachment identity, workspace or durable reference was not confirmed")
		}
		metadata[id] = m
		return nil
	}
	// Check existing references before uploading any new files.
	for _, id := range ids {
		if err := load(id); err != nil {
			return err
		}
	}
	if len(local) > 0 {
		if k.opts.UploadAttachments == nil {
			return errors.New("Local attachment upload is unavailable")
		}
		uploaded, err := k.opts.UploadAttachments(ctx, local)
		if err != nil {
			return err
		}
		for _, id := range uploaded {
			if err := load(id); err != nil {
				return err
			}
		}
		ids = append(ids, uploaded...)
	}
	text, supplied := body[textField].(string)
	if !supplied {
		text = previous
	}
	seen := map[string]bool{}
	unique := []string{}
	escape := strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "\r", " ", "\n", " ")
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
		m := metadata[id]
		ref := str(m, "markdown_url")
		if strings.Contains(text, ref) {
			continue
		}
		name := str(m, "filename")
		if name == "" {
			name = id
		}
		prefix := ""
		if strings.HasPrefix(str(m, "content_type"), "image/") {
			prefix = "!"
		}
		text += "\n\n" + prefix + "[" + escape.Replace(name) + "](<" + strings.ReplaceAll(ref, ">", "%3E") + ">)"
	}
	body["attachment_ids"], body[textField] = unique, text
	return nil
}

func (k *toolkit) attachmentReceipt(ctx context.Context, kind, action string, value any, identity string, body row) (any, error) {
	receipt, err := k.receipt(ctx, kind, action, value, identity)
	if err != nil || kind != "task" || len(attachmentIDs(body["attachment_ids"])) == 0 {
		return receipt, err
	}
	if identity == "" {
		identity = str(value.(row), "id")
	}
	verify := func() error {
		v, err := k.get(ctx, roots["task"]+"/"+url.PathEscape(identity)+"/attachments")
		if err != nil {
			return err
		}
		list, err := asRows(v)
		if err != nil {
			return err
		}
		found := map[string]bool{}
		for _, a := range list {
			found[str(a, "id")] = true
		}
		for _, id := range attachmentIDs(body["attachment_ids"]) {
			if !found[id] {
				return fmt.Errorf("attachment %s is absent", id)
			}
		}
		return nil
	}
	if err := verify(); err != nil {
		return nil, fmt.Errorf("Task %s was written, but attachment delivery was not confirmed. Inspect the task before retrying: %w", identity, err)
	}
	receipt.(row)["attachment_ids"] = body["attachment_ids"]
	return receipt, nil
}
