package workspace

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
)

// Options configures one execution's tools.
type Options struct {
	WorkspaceID string
	UserID      string
	// ConversationID is the local conversation the execution serves.
	ConversationID string
	// AppURL, when set, adds a web link to write receipts.
	AppURL string
	// Request calls the workspace API; nil leaves only local tools.
	Request Requester
	// Local acts on this account's local conversations; nil leaves them out.
	Local Local
}

var roots = map[string]string{
	"task": "/api/issues", "project": "/api/projects", "agent": "/api/agents", "squad": "/api/squads",
	"skill": "/api/skills", "autopilot": "/api/autopilots", "conversation": "/api/chat/sessions",
}

var appPaths = map[string]string{
	"task": "issues/", "project": "projects/", "agent": "agents/", "squad": "squads/",
	"skill": "skills/", "autopilot": "autopilots/", "conversation": "chat?session=",
}

var (
	taskFields = row{"title": sShort, "description": sText, "status": sShort, "priority": sShort, "assignee_type": sAssignee,
		"assignee_id": sNullID, "project_id": sNullID, "parent_issue_id": sNullID, "stage": row{"type": "integer", "minimum": 1}, "start_date": sDate, "due_date": sDate}
	projectFields = row{"title": sShort, "description": sText, "status": sShort, "priority": sShort, "lead_type": sAssignee, "lead_id": sNullID, "start_date": sDate, "due_date": sDate}
	agentFields   = row{"name": sShort, "description": sText, "instructions": sText, "model": row{"type": "string", "maxLength": 200},
		"thinking_level": row{"type": "string", "maxLength": 100}, "max_concurrent_tasks": row{"type": "integer", "minimum": 1, "maximum": 100}}
	squadFields     = row{"name": sShort, "description": sText, "instructions": sText, "leader_id": sID}
	skillFiles      = array(row{"type": "object", "additionalProperties": false, "required": []string{"path", "content"}, "properties": row{"path": row{"type": "string", "minLength": 1, "maxLength": 512}, "content": sText}}, 50)
	skillFields     = row{"name": sShort, "description": sText, "content": sText, "files": skillFiles}
	autopilotFields = row{"title": sShort, "description": sText, "project_id": sNullID, "assignee_type": enum("agent", "squad"), "assignee_id": sID,
		"execution_mode": enum("create_issue", "run_only"), "issue_title_template": row{"type": "string", "maxLength": 1024}}
	paging = row{"limit": sLimit, "offset": sOffset}
)

// Tools returns the workspace tools of one execution.
func Tools(opts Options) []contextmcp.Tool {
	k := &toolkit{opts: opts, write: map[string]*writeResult{}}
	if opts.Request != nil {
		k.cloudTools()
	}
	if opts.Local != nil {
		k.localTools()
	}
	return k.tools
}

func (k *toolkit) get(ctx context.Context, path string) (any, error) {
	return k.opts.Request.Request(ctx, http.MethodGet, path, nil)
}

func (k *toolkit) do(ctx context.Context, method, path string, body any) (any, error) {
	return k.opts.Request.Request(ctx, method, path, body)
}

func (k *toolkit) workspace(ctx context.Context) (row, error) {
	k.mu.Lock()
	ws := k.ws
	k.mu.Unlock()
	if ws != nil {
		return ws, nil
	}
	v, err := k.get(ctx, "/api/workspaces/"+k.opts.WorkspaceID)
	if err != nil {
		return nil, err
	}
	ws, err = asRow(v)
	if err != nil {
		return nil, err
	}
	if ws["id"] != k.opts.WorkspaceID {
		return nil, errors.New("Workspace identity mismatch")
	}
	k.mu.Lock()
	k.ws = ws
	k.mu.Unlock()
	return ws, nil
}

// ensure reads a resource and checks it belongs to the workspace.
func (k *toolkit) ensure(ctx context.Context, kind, id string) (row, error) {
	v, err := k.get(ctx, roots[kind]+"/"+url.PathEscape(id))
	if err != nil {
		return nil, err
	}
	res, err := asRow(v)
	if err != nil {
		return nil, err
	}
	if kind == "autopilot" {
		if inner, ok := res["autopilot"].(row); ok {
			value := without(inner)
			value["triggers"], value["collaborators"] = res["triggers"], res["collaborators"]
			res = value
		}
	}
	if res["workspace_id"] != k.opts.WorkspaceID {
		return nil, errors.New("Resource is outside the selected workspace")
	}
	return res, nil
}

func (k *toolkit) members(ctx context.Context) ([]row, error) {
	v, err := k.get(ctx, "/api/workspaces/"+k.opts.WorkspaceID+"/members")
	if err != nil {
		return nil, err
	}
	return asRows(v)
}

func (k *toolkit) ensureAssignee(ctx context.Context, typ, id any) error {
	identity, _ := id.(string)
	if identity == "" {
		return nil
	}
	switch typ {
	case "agent", "squad":
		_, err := k.ensure(ctx, typ.(string), identity)
		return err
	case "member":
		members, err := k.members(ctx)
		if err != nil {
			return err
		}
		for _, m := range members {
			if m["user_id"] == identity || m["id"] == identity {
				return nil
			}
		}
		return errors.New("Member is outside the selected workspace")
	}
	return errors.New("Provide assignee_type together with assignee_id")
}

func (k *toolkit) taskRefs(ctx context.Context, in row) error {
	if id := str(in, "project_id"); id != "" {
		if _, err := k.ensure(ctx, "project", id); err != nil {
			return err
		}
	}
	if id := str(in, "parent_issue_id"); id != "" {
		if _, err := k.ensure(ctx, "task", id); err != nil {
			return err
		}
	}
	return k.ensureAssignee(ctx, in["assignee_type"], in["assignee_id"])
}

// receipt describes a write: what changed, where, and a link to it.
func (k *toolkit) receipt(ctx context.Context, kind, action string, value any, identity string) (any, error) {
	object, _ := value.(row)
	if action == "created" {
		id, _ := object["id"].(string)
		if !idPattern.MatchString(id) || object["workspace_id"] != k.opts.WorkspaceID {
			return nil, errors.New("The server did not confirm a created resource in this workspace. Inspect current state before trying again.")
		}
	}
	if ws, ok := object["workspace_id"]; ok && ws != nil && ws != k.opts.WorkspaceID {
		return nil, errors.New("The response is outside the selected workspace")
	}
	if identity == "" {
		identity, _ = object["id"].(string)
	}
	var link any
	if k.opts.AppURL != "" && identity != "" {
		// A successful write is not reported as failed when its link lookup fails.
		if ws, err := k.workspace(ctx); err == nil {
			if slug, ok := ws["slug"].(string); ok {
				link = strings.TrimRight(k.opts.AppURL, "/") + "/" + url.PathEscape(slug) + "/" + appPaths[kind] + url.QueryEscape(identity)
			}
		}
	}
	var id any
	if identity != "" {
		id = identity
	}
	return row{"kind": kind, "action": action, "id": id, "workspace_id": k.opts.WorkspaceID, "url": link, "data": clean(value)}, nil
}

// pageOf returns the list of a response that is either a list or an
// object holding one under the first present key.
func pageOf(v any, keys ...string) ([]row, row, error) {
	if list, ok := v.([]any); ok {
		rows, err := asRows(list)
		return rows, nil, err
	}
	page, err := asRow(v)
	if err != nil {
		return nil, nil, err
	}
	for _, key := range keys {
		if list, ok := page[key]; ok && list != nil {
			rows, err := asRows(list)
			return rows, page, err
		}
	}
	return nil, page, errors.New("Multica returned an invalid list")
}

func (k *toolkit) ensureRun(ctx context.Context, runID, conversationID, taskID, before string) error {
	if (conversationID == "") == (taskID == "") {
		return errors.New("Supply exactly one owning conversation_id or task_id")
	}
	kind, owner, path := "task", taskID, roots["task"]+"/"+url.PathEscape(taskID)+"/task-runs"
	if conversationID != "" {
		kind, owner, path = "conversation", conversationID, roots["conversation"]+"/"+url.PathEscape(conversationID)+"/tasks"
	}
	if _, err := k.ensure(ctx, kind, owner); err != nil {
		return err
	}
	v, err := k.get(ctx, query(path, row{"limit": 200, "before": before}))
	if err != nil {
		return err
	}
	list, _, err := pageOf(v, "items")
	if err != nil {
		return err
	}
	for _, r := range list {
		if r["id"] == runID && r["workspace_id"] == k.opts.WorkspaceID {
			return nil
		}
	}
	return errors.New("Execution not found in this owner's page. For older runs, pass its list cursor as runs_before.")
}

func (k *toolkit) cloudTools() {
	k.tool("workspace_info", "Read the selected workspace and its members, issue statuses and labels. Use IDs from this catalog rather than guessing assignees or status keys.", row{}, nil, false,
		func(ctx context.Context, _ row, _ string) (any, error) {
			ws, err := k.workspace(ctx)
			if err != nil {
				return nil, err
			}
			members, err := k.members(ctx)
			if err != nil {
				return nil, err
			}
			statuses, err := k.get(ctx, "/api/issue-statuses")
			if err != nil {
				return nil, err
			}
			labels, err := k.get(ctx, "/api/labels")
			if err != nil {
				return nil, err
			}
			return row{"workspace": row{"id": ws["id"], "name": ws["name"], "slug": ws["slug"]}, "current_user_id": k.opts.UserID, "members": members, "statuses": statuses, "labels": labels}, nil
		})

	k.tool("list_workspace_items", "List or search tasks, projects, defined Multica agents, squads, Skills or automations in the current workspace. Tasks support status/project/assignee filters; mine=true selects the current member's tasks. Follow next_offset for more results.",
		props(paging, row{"kind": enum("task", "project", "agent", "squad", "skill", "autopilot"), "query": row{"type": "string", "maxLength": 200, "default": ""},
			"status": sShort, "project_id": sID, "assignee_id": sID, "mine": row{"type": "boolean", "default": false}}), []string{"kind"}, false,
		func(ctx context.Context, in row, _ string) (any, error) { return k.listItems(ctx, in) })

	k.tool("read_workspace_item", "Read a project (including resources), defined agent (including assigned Skills), squad (including members), Skill (including bundled files), task, or automation. For full task discussion use read_context. Credentials and private runtime configuration are omitted.",
		row{"kind": enum("task", "project", "agent", "squad", "skill", "autopilot", "conversation"), "id": sID}, []string{"kind", "id"}, false,
		func(ctx context.Context, in row, _ string) (any, error) {
			kind, id := str(in, "kind"), str(in, "id")
			value, err := k.ensure(ctx, kind, id)
			if err != nil {
				return nil, err
			}
			out := row{"kind": kind, "data": value}
			if child, ok := map[string]string{"project": "resources", "agent": "skills", "squad": "members", "skill": "files"}[kind]; ok {
				if v, ok := value[child]; ok {
					out[child] = v
				} else if out[child], err = k.get(ctx, roots[kind]+"/"+url.PathEscape(id)+"/"+child); err != nil {
					return nil, err
				}
			}
			return out, nil
		})

	k.taskTools()
	k.projectTools()
	k.agentTools()
	k.squadAndSkillTools()
	k.autopilotTools()
	k.inboxAndRunTools()
}

func (k *toolkit) listItems(ctx context.Context, in row) (any, error) {
	kind, search := str(in, "kind"), str(in, "query")
	limit, offset := num(in, "limit", 25), num(in, "offset", 0)
	mine, _ := boolean(in, "mine")
	assignee := str(in, "assignee_id")
	if mine {
		assignee = k.opts.UserID
	}
	var v any
	var err error
	effective := limit
	if kind == "task" && search != "" {
		effective = min(limit, 50)
		v, err = k.get(ctx, query(roots["task"]+"/search", row{"q": search, "limit": effective, "offset": offset, "include_closed": true}))
	} else if kind == "task" {
		filters := row{"limit": limit, "offset": offset, "status": str(in, "status"), "project_id": str(in, "project_id"), "assignee_id": assignee}
		if mine {
			filters["assignee_type"] = "member"
		}
		v, err = k.get(ctx, query(roots["task"], filters))
	} else {
		v, err = k.get(ctx, query(roots[kind], row{"workspace_id": k.opts.WorkspaceID}))
	}
	if err != nil {
		return nil, err
	}
	plural := kind + "s"
	if kind == "autopilot" {
		plural = "autopilots"
	}
	source, page, err := pageOf(v, "issues", "items", plural)
	if err != nil {
		return nil, err
	}
	for _, e := range source {
		if ws, ok := e["workspace_id"]; ok && ws != nil && ws != k.opts.WorkspaceID {
			return nil, errors.New("Resource list is outside the selected workspace")
		}
	}
	var list []row
	more := false
	consumed := 0
	if kind != "task" {
		var matches []row
		for _, e := range source {
			name, _ := e["title"].(string)
			if name == "" {
				name, _ = e["name"].(string)
			}
			if search == "" || strings.Contains(strings.ToLower(name), strings.ToLower(search)) {
				matches = append(matches, e)
			}
		}
		end := min(offset+limit, len(matches))
		if offset < end {
			list = matches[offset:end]
		}
		consumed, more = len(list), offset+len(list) < len(matches)
	} else {
		consumed = len(source)
		list = source
		if search != "" {
			list = nil
			for _, e := range source {
				if (str(in, "status") == "" || e["status"] == str(in, "status")) && (str(in, "project_id") == "" || e["project_id"] == str(in, "project_id")) && (assignee == "" || e["assignee_id"] == assignee) {
					list = append(list, e)
				}
			}
		}
		if hasMore, ok := page["has_more"].(bool); page != nil && ok {
			more = hasMore
		} else {
			more = len(source) == effective
		}
	}
	var next any
	if more {
		next = offset + consumed
	}
	if list == nil {
		list = []row{}
	}
	return row{"kind": kind, "items": list, "has_more": more, "next_offset": next}, nil
}

// simple registers a write that checks resource kind/id, sends body and
// reports action.
func (k *toolkit) updateTool(name, description, kind string, fields row, method string, check func(context.Context, row) error) {
	k.tool(name, description, props(fields, row{"id": sID}), []string{"id"}, true, func(ctx context.Context, in row, _ string) (any, error) {
		id := str(in, "id")
		if _, err := k.ensure(ctx, kind, id); err != nil {
			return nil, err
		}
		body := without(in, "id")
		if check != nil {
			if err := check(ctx, body); err != nil {
				return nil, err
			}
		}
		if _, err := nonempty(body); err != nil {
			return nil, err
		}
		v, err := k.do(ctx, method, roots[kind]+"/"+url.PathEscape(id), body)
		if err != nil {
			return nil, err
		}
		return k.receipt(ctx, kind, "updated", v, id)
	})
}

func (k *toolkit) createTool(name, description, kind string, fields row, required []string, check func(context.Context, row) error) {
	k.tool(name, description, fields, required, true, func(ctx context.Context, in row, _ string) (any, error) {
		if check != nil {
			if err := check(ctx, in); err != nil {
				return nil, err
			}
		}
		v, err := k.do(ctx, http.MethodPost, roots[kind], in)
		if err != nil {
			return nil, err
		}
		return k.receipt(ctx, kind, "created", v, "")
	})
}

func (k *toolkit) taskTools() {
	k.createTool("create_task", "Create a task or subtask. Assigning it to an agent/squad may start execution under the existing workflow. Status keys come from workspace_info. Returns the created object and link.",
		"task", taskFields, []string{"title"}, k.taskRefs)
	k.updateTool("update_task", "Update task content, assignee, project, parent, dates or status. Read first; expected_revision detects concurrent edits. suppress_run=true updates assignment/status without starting a run.",
		"task", props(taskFields, row{"expected_revision": row{"type": "integer", "minimum": 0}, "suppress_run": sBool, "duplicate_of_issue_id": sID}), http.MethodPut,
		func(ctx context.Context, in row) error {
			if err := k.taskRefs(ctx, in); err != nil {
				return err
			}
			if id := str(in, "duplicate_of_issue_id"); id != "" {
				_, err := k.ensure(ctx, "task", id)
				return err
			}
			return nil
		})
	k.tool("comment_task", "Add a task comment or reply. Only post content the user requested to share. Existing mention/workflow rules may invoke agents.",
		row{"id": sID, "content": row{"type": "string", "minLength": 1, "maxLength": 100000}, "parent_id": sNullID, "attachment_ids": array(sID, 50), "suppress_agent_ids": array(sID, 50)}, []string{"id", "content"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			id := str(in, "id")
			if _, err := k.ensure(ctx, "task", id); err != nil {
				return nil, err
			}
			v, err := k.do(ctx, http.MethodPost, roots["task"]+"/"+url.PathEscape(id)+"/comments", without(in, "id"))
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "task", "commented", v, id)
		})
	k.tool("task_activity", "Read a task's timeline, subtask list, labels or execution runs. Use run_messages to read observable execution output.",
		props(paging, row{"id": sID, "view": enum("timeline", "children", "labels", "task-runs")}), []string{"id", "view"}, false,
		func(ctx context.Context, in row, _ string) (any, error) {
			id, view := str(in, "id"), str(in, "view")
			limit, offset := num(in, "limit", 25), num(in, "offset", 0)
			if _, err := k.ensure(ctx, "task", id); err != nil {
				return nil, err
			}
			params := row{}
			if view == "timeline" {
				params["limit"] = limit
			}
			v, err := k.get(ctx, query(roots["task"]+"/"+url.PathEscape(id)+"/"+view, params))
			if err != nil {
				return nil, err
			}
			all, page, err := pageOf(v, "entries", "items")
			if err != nil {
				return nil, err
			}
			end := min(offset+limit, len(all))
			items := []row{}
			if offset < end {
				items = all[offset:end]
			}
			more := offset+len(items) < len(all)
			var next any
			if more {
				next = offset + len(items)
			}
			truncated := page != nil && (page["has_more_before"] == true || page["has_more_after"] == true)
			return row{"items": items, "has_more": more, "next_offset": next, "source_truncated": truncated}, nil
		})
	k.tool("set_task_label", "Attach or detach an existing workspace label from a task.",
		row{"id": sID, "label_id": sID, "attached": sBool}, []string{"id", "label_id", "attached"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			id, label := str(in, "id"), str(in, "label_id")
			attached, _ := boolean(in, "attached")
			if _, err := k.ensure(ctx, "task", id); err != nil {
				return nil, err
			}
			v, err := k.get(ctx, "/api/labels")
			if err != nil {
				return nil, err
			}
			labels, err := asRows(v)
			if err != nil {
				return nil, err
			}
			found := false
			for _, l := range labels {
				found = found || l["id"] == label
			}
			if !found {
				return nil, errors.New("Label is outside the selected workspace")
			}
			base := roots["task"] + "/" + url.PathEscape(id) + "/labels"
			action := "label_attached"
			if attached {
				_, err = k.do(ctx, http.MethodPost, base, row{"label_id": label})
			} else {
				action = "label_detached"
				_, err = k.do(ctx, http.MethodDelete, base+"/"+url.PathEscape(label), nil)
			}
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "task", action, row{"label_id": label}, id)
		})
	k.tool("manage_task_pull_request", "Read, link or unlink an existing pull request from a task. This changes its Multica association; it does not create, merge or comment on the external pull request.",
		row{"id": sID, "action": enum("list", "link", "unlink"), "url": row{"type": "string", "format": "uri", "maxLength": 2048}, "pull_request_id": sID}, []string{"id", "action"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			id, action, link, pr := str(in, "id"), str(in, "action"), str(in, "url"), str(in, "pull_request_id")
			if _, err := k.ensure(ctx, "task", id); err != nil {
				return nil, err
			}
			base := roots["task"] + "/" + url.PathEscape(id) + "/pull-requests"
			switch action {
			case "list":
				return k.get(ctx, base)
			case "link":
				if link == "" && pr == "" {
					return nil, errors.New("Supply a pull request URL or existing pull_request_id")
				}
				body := row{}
				if link != "" {
					body["url"] = link
				}
				if pr != "" {
					body["pull_request_id"] = pr
				}
				v, err := k.do(ctx, http.MethodPost, base, body)
				if err != nil {
					return nil, err
				}
				return k.receipt(ctx, "task", "pull_request_link", v, id)
			}
			v, err := k.get(ctx, base)
			if err != nil {
				return nil, err
			}
			existing, err := asRows(v)
			if err != nil {
				return nil, err
			}
			linked := false
			for _, e := range existing {
				linked = linked || (pr != "" && (e["id"] == pr || e["pull_request_id"] == pr))
			}
			if !linked {
				return nil, errors.New("Pull request is not linked to this task")
			}
			v, err = k.do(ctx, http.MethodDelete, base+"/"+url.PathEscape(pr), nil)
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "task", "pull_request_unlink", v, id)
		})
	k.actionTool("rerun_task", "Start a new execution for a task using Multica's existing rerun action. This may consume the assigned agent's model quota.", "task", "rerun", "rerun_requested")
}

// actionTool registers a POST {root}/{id}/{path} action.
func (k *toolkit) actionTool(name, description, kind, path, action string) {
	k.tool(name, description, row{"id": sID}, []string{"id"}, true, func(ctx context.Context, in row, _ string) (any, error) {
		id := str(in, "id")
		if _, err := k.ensure(ctx, kind, id); err != nil {
			return nil, err
		}
		v, err := k.do(ctx, http.MethodPost, roots[kind]+"/"+url.PathEscape(id)+"/"+path, row{})
		if err != nil {
			return nil, err
		}
		return k.receipt(ctx, kind, action, v, id)
	})
}

func (k *toolkit) projectTools() {
	lead := func(ctx context.Context, in row) error { return k.ensureAssignee(ctx, in["lead_type"], in["lead_id"]) }
	k.createTool("create_project", "Create a project with description, lead and dates.", "project", projectFields, []string{"title"}, lead)
	k.updateTool("update_project", "Update a project's title, description, lead, status, priority or dates. Move tasks with update_task(project_id).", "project", projectFields, http.MethodPut, lead)
	k.tool("manage_project_repository", "Add, update or remove a project's repository resource without cloning or reading files. Existing API resource_type is github_repo; local directory resources and filesystem operations are excluded.",
		row{"project_id": sID, "resource_id": sID, "action": enum("add", "update", "remove"), "url": row{"type": "string", "format": "uri", "maxLength": 2048}, "ref": row{"type": "string", "maxLength": 256}, "label": sShort},
		[]string{"project_id", "action"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			project, resource, action, link := str(in, "project_id"), str(in, "resource_id"), str(in, "action"), str(in, "url")
			if _, err := k.ensure(ctx, "project", project); err != nil {
				return nil, err
			}
			base := roots["project"] + "/" + url.PathEscape(project) + "/resources"
			if action != "add" {
				v, err := k.get(ctx, base)
				if err != nil {
					return nil, err
				}
				resources, err := asRows(v)
				if err != nil {
					return nil, err
				}
				found := false
				for _, r := range resources {
					found = found || (resource != "" && r["id"] == resource && r["resource_type"] == "github_repo")
				}
				if !found {
					return nil, errors.New("Repository resource not found in this project")
				}
			}
			if action != "remove" && link == "" {
				return nil, errors.New("Supply the repository URL")
			}
			method, path, body := http.MethodPost, base, any(nil)
			if action != "remove" {
				ref := row{"url": link}
				if r := str(in, "ref"); r != "" {
					ref["ref"] = r
				}
				b := row{"resource_ref": ref}
				if action == "add" {
					b["resource_type"] = "github_repo"
				}
				if l := str(in, "label"); l != "" {
					b["label"] = l
				}
				body = b
			}
			switch action {
			case "update":
				method, path = http.MethodPut, base+"/"+url.PathEscape(resource)
			case "remove":
				method, path = http.MethodDelete, base+"/"+url.PathEscape(resource)
			}
			v, err := k.do(ctx, method, path, body)
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "project", "repository_"+action, v, project)
		})
}

func (k *toolkit) agentTools() {
	k.createTool("create_agent", "Create a defined Multica agent using an existing runtime_id. This is agent configuration, not a Codex/Claude runner entry. Does not create or manage runtimes, permissions, credentials or environment variables.",
		"agent", props(agentFields, row{"runtime_id": sID, "skill_ids": array(sID, 100)}), []string{"name", "runtime_id"},
		func(ctx context.Context, in row) error {
			skills, _ := in["skill_ids"].([]any)
			for _, s := range skills {
				if _, err := k.ensure(ctx, "skill", s.(string)); err != nil {
					return err
				}
			}
			return nil
		})
	k.updateTool("update_agent", "Update a defined agent's name, description, instructions, model or concurrency. Does not run it or change credentials or invocation permissions.", "agent", agentFields, http.MethodPut, nil)
	k.tool("archive_agent", "Archive or restore a defined agent. Archive is reversible and does not erase history.",
		row{"id": sID, "archived": sBool}, []string{"id", "archived"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			id := str(in, "id")
			archived, _ := boolean(in, "archived")
			if _, err := k.ensure(ctx, "agent", id); err != nil {
				return nil, err
			}
			path, action := "restore", "restored"
			if archived {
				path, action = "archive", "archived"
			}
			v, err := k.do(ctx, http.MethodPost, roots["agent"]+"/"+url.PathEscape(id)+"/"+path, row{})
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "agent", action, v, id)
		})
	k.tool("assign_agent_skill", "Add, remove or enable/disable a Skill on a defined agent. Adding preserves its other Skills.",
		row{"agent_id": sID, "skill_id": sID, "action": enum("add", "remove", "enable", "disable")}, []string{"agent_id", "skill_id", "action"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			agent, skill, action := str(in, "agent_id"), str(in, "skill_id"), str(in, "action")
			if _, err := k.ensure(ctx, "agent", agent); err != nil {
				return nil, err
			}
			if _, err := k.ensure(ctx, "skill", skill); err != nil {
				return nil, err
			}
			base := roots["agent"] + "/" + url.PathEscape(agent) + "/skills"
			var v any
			var err error
			switch action {
			case "add":
				v, err = k.do(ctx, http.MethodPost, base+"/add", row{"skill_ids": []string{skill}})
			case "remove":
				v, err = k.do(ctx, http.MethodDelete, base+"/"+url.PathEscape(skill), nil)
			default:
				v, err = k.do(ctx, http.MethodPut, base+"/"+url.PathEscape(skill)+"/enabled", row{"enabled": action == "enable"})
			}
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "agent", "skill_"+action, v, agent)
		})
	k.tool("agent_mcp_servers", "Read the workspace MCP library metadata and an agent's current MCP assignments. Does not return server configuration, headers, credentials or environment variables.",
		row{"agent_id": sID}, []string{"agent_id"}, false,
		func(ctx context.Context, in row, _ string) (any, error) {
			agent := str(in, "agent_id")
			if _, err := k.ensure(ctx, "agent", agent); err != nil {
				return nil, err
			}
			library, err := k.get(ctx, "/api/workspaces/"+k.opts.WorkspaceID+"/mcp-servers")
			if err != nil {
				return nil, err
			}
			assigned, err := k.get(ctx, roots["agent"]+"/"+url.PathEscape(agent)+"/mcp-servers")
			if err != nil {
				return nil, err
			}
			return row{"library": library, "assigned": assigned}, nil
		})
	k.tool("assign_agent_mcp", "Add/remove or enable/disable an existing workspace MCP server on a defined agent at the user's explicit request. Does not create servers, change credentials or manage runtimes.",
		row{"agent_id": sID, "server_id": sID, "action": enum("add", "remove", "enable", "disable")}, []string{"agent_id", "server_id", "action"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			agent, server, action := str(in, "agent_id"), str(in, "server_id"), str(in, "action")
			if _, err := k.ensure(ctx, "agent", agent); err != nil {
				return nil, err
			}
			v, err := k.get(ctx, "/api/workspaces/"+k.opts.WorkspaceID+"/mcp-servers")
			if err != nil {
				return nil, err
			}
			library, err := asRows(v)
			if err != nil {
				return nil, err
			}
			found := false
			for _, e := range library {
				found = found || e["id"] == server
			}
			if !found {
				return nil, errors.New("MCP server is outside the selected workspace")
			}
			base := roots["agent"] + "/" + url.PathEscape(agent) + "/mcp-servers"
			switch action {
			case "add":
				v, err = k.do(ctx, http.MethodPost, base, row{"server_id": server})
			case "remove":
				v, err = k.do(ctx, http.MethodDelete, base+"/"+url.PathEscape(server), nil)
			default:
				v, err = k.do(ctx, http.MethodPut, base+"/"+url.PathEscape(server)+"/enabled", row{"enabled": action == "enable"})
			}
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "agent", "mcp_"+action, v, agent)
		})
}

func (k *toolkit) squadAndSkillTools() {
	k.createTool("create_squad", "Create a squad with an existing defined agent as leader. Assign tasks to the squad to use its existing orchestration.",
		"squad", row{"name": sShort, "description": sText, "leader_id": sID}, []string{"name", "leader_id"},
		func(ctx context.Context, in row) error {
			_, err := k.ensure(ctx, "agent", str(in, "leader_id"))
			return err
		})
	k.updateTool("update_squad", "Update squad instructions, description, name or leader.", "squad", squadFields, http.MethodPut,
		func(ctx context.Context, in row) error {
			if leader := str(in, "leader_id"); leader != "" {
				_, err := k.ensure(ctx, "agent", leader)
				return err
			}
			return nil
		})
	k.tool("manage_squad_member", "Add/remove a squad member or update their role. Read the squad first; membership follows existing server rules.",
		row{"squad_id": sID, "member_type": enum("member", "agent"), "member_id": sID, "role": sShort, "action": enum("add", "remove", "set_role")},
		[]string{"squad_id", "member_type", "member_id", "action"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			squad, action := str(in, "squad_id"), str(in, "action")
			if _, err := k.ensure(ctx, "squad", squad); err != nil {
				return nil, err
			}
			if err := k.ensureAssignee(ctx, in["member_type"], in["member_id"]); err != nil {
				return nil, err
			}
			if action != "remove" && str(in, "role") == "" {
				return nil, errors.New("Supply the member's role")
			}
			body := without(in, "squad_id", "action")
			method, path := http.MethodPost, roots["squad"]+"/"+url.PathEscape(squad)+"/members"
			switch action {
			case "remove":
				method, body = http.MethodDelete, row{"member_type": in["member_type"], "member_id": in["member_id"]}
			case "set_role":
				method, path = http.MethodPatch, path+"/role"
			}
			v, err := k.do(ctx, method, path, body)
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "squad", "member_"+action, v, squad)
		})
	k.createTool("create_skill", "Create a reusable Skill from instructions and optional bundled text files. This manages Skill content in Multica, not local filesystem files.",
		"skill", props(skillFields, row{"content": row{"type": "string", "minLength": 1, "maxLength": 100000}}), []string{"name", "content"}, nil)
	k.updateTool("update_skill", "Update a Skill's name, description or instructions. If files is supplied, it follows the existing API's bundle replacement semantics; read the existing bundle first.", "skill", skillFields, http.MethodPut, nil)
}

func (k *toolkit) autopilotTools() {
	k.createTool("create_autopilot", "Create an automation assigned to a defined agent or squad. Add a schedule separately with manage_autopilot_schedule. Does not start a run by itself.",
		"autopilot", autopilotFields, []string{"title", "assignee_id"},
		func(ctx context.Context, in row) error {
			typ := in["assignee_type"]
			if typ == nil {
				typ = "agent"
			}
			if err := k.ensureAssignee(ctx, typ, in["assignee_id"]); err != nil {
				return err
			}
			if p := str(in, "project_id"); p != "" {
				_, err := k.ensure(ctx, "project", p)
				return err
			}
			return nil
		})
	k.tool("update_autopilot", "Update automation instructions, assignment, project or active/paused status. Does not alter trigger credentials.",
		props(autopilotFields, row{"id": sID, "status": enum("active", "paused")}), []string{"id"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			id := str(in, "id")
			current, err := k.ensure(ctx, "autopilot", id)
			if err != nil {
				return nil, err
			}
			typ := in["assignee_type"]
			if typ == nil {
				typ = current["assignee_type"]
			}
			if typ == nil {
				typ = "agent"
			}
			if err := k.ensureAssignee(ctx, typ, in["assignee_id"]); err != nil {
				return nil, err
			}
			if p := str(in, "project_id"); p != "" {
				if _, err := k.ensure(ctx, "project", p); err != nil {
					return nil, err
				}
			}
			body, err := nonempty(without(in, "id"))
			if err != nil {
				return nil, err
			}
			v, err := k.do(ctx, http.MethodPatch, roots["autopilot"]+"/"+url.PathEscape(id), body)
			if err != nil {
				return nil, err
			}
			return k.receipt(ctx, "autopilot", "updated", v, id)
		})
	triggerTool := func(name, description, kind string, fields row, create func(row) (row, error)) {
		k.tool(name, description, props(fields, row{"autopilot_id": sID, "action": enum("create", "update", "remove"), "trigger_id": sID}), []string{"autopilot_id", "action"}, true,
			func(ctx context.Context, in row, _ string) (any, error) {
				autopilot, action, trigger := str(in, "autopilot_id"), str(in, "action"), str(in, "trigger_id")
				current, err := k.ensure(ctx, "autopilot", autopilot)
				if err != nil {
					return nil, err
				}
				base := roots["autopilot"] + "/" + url.PathEscape(autopilot) + "/triggers"
				input := without(in, "autopilot_id", "action", "trigger_id")
				if action == "create" {
					body, err := create(input)
					if err != nil {
						return nil, err
					}
					body["kind"] = kind
					v, err := k.do(ctx, http.MethodPost, base, body)
					if err != nil {
						return nil, err
					}
					return k.receipt(ctx, "autopilot", kind+"_created", v, autopilot)
				}
				triggers, _ := current["triggers"].([]any)
				found := false
				for _, t := range triggers {
					if t, ok := t.(row); ok && trigger != "" && t["id"] == trigger && t["kind"] == kind {
						found = true
					}
				}
				if !found {
					return nil, fmt.Errorf("%s trigger not found in this automation", map[string]string{"schedule": "Schedule", "webhook": "Webhook"}[kind])
				}
				if _, ok := input["provider"]; ok && kind == "webhook" {
					return nil, errors.New("The provider of an existing trigger cannot be changed")
				}
				method, body := http.MethodDelete, any(nil)
				if action == "update" {
					b, err := nonempty(input)
					if err != nil {
						return nil, err
					}
					method, body = http.MethodPatch, b
				}
				v, err := k.do(ctx, method, base+"/"+url.PathEscape(trigger), body)
				if err != nil {
					return nil, err
				}
				return k.receipt(ctx, "autopilot", kind+"_"+action, v, autopilot)
			})
	}
	triggerTool("manage_autopilot_schedule", "Add, update or remove a schedule trigger. Creating requires a cron_expression and explicit IANA timezone. Only schedule triggers are managed here; webhook secrets are not exposed.", "schedule",
		row{"cron_expression": row{"type": "string", "minLength": 1, "maxLength": 256}, "timezone": row{"type": "string", "minLength": 1, "maxLength": 100}, "enabled": sBool, "label": sShort},
		func(in row) (row, error) {
			if str(in, "cron_expression") == "" || str(in, "timezone") == "" {
				return nil, errors.New("A new schedule requires cron_expression and timezone")
			}
			if enabled, ok := boolean(in, "enabled"); ok && !enabled {
				return nil, errors.New("Create the schedule, then disable it with update")
			}
			return without(in, "enabled"), nil
		})
	triggerTool("manage_autopilot_webhook", "Create, update or remove an automation's generic/GitHub event trigger. Event scopes use event and optional actions. Webhook URLs, tokens and signing secrets are omitted; copy/configure them in the application rather than exposing them to a model.", "webhook",
		row{"provider": enum("generic", "github"), "enabled": sBool, "label": sShort,
			"event_filters": array(row{"type": "object", "additionalProperties": false, "required": []string{"event"}, "properties": row{"event": sShort, "actions": array(sShort, 100)}}, 100)},
		func(in row) (row, error) {
			if _, ok := in["enabled"]; ok {
				return nil, errors.New("Set enabled with update after creating the trigger")
			}
			return in, nil
		})
	k.actionTool("trigger_autopilot", "Run an automation once now. This may create tasks and consume the assigned agent's model quota.", "autopilot", "trigger", "triggered")
	k.tool("autopilot_runs", "Read execution history for an automation, or details for one of its runs. Follow next_offset for older runs.",
		props(paging, row{"id": sID, "run_id": sID}), []string{"id"}, false,
		func(ctx context.Context, in row, _ string) (any, error) {
			id, run := str(in, "id"), str(in, "run_id")
			limit, offset := num(in, "limit", 25), num(in, "offset", 0)
			if _, err := k.ensure(ctx, "autopilot", id); err != nil {
				return nil, err
			}
			base := roots["autopilot"] + "/" + url.PathEscape(id) + "/runs"
			if run != "" {
				return k.get(ctx, base+"/"+url.PathEscape(run))
			}
			v, err := k.get(ctx, query(base, row{"limit": limit, "offset": offset}))
			if err != nil {
				return nil, err
			}
			items, _, err := pageOf(v, "runs")
			if err != nil {
				return nil, err
			}
			more := len(items) == limit
			var next any
			if more {
				next = offset + len(items)
			}
			return row{"items": items, "has_more": more, "next_offset": next}, nil
		})
}

func (k *toolkit) inboxAndRunTools() {
	k.tool("list_inbox", "Read the current user's inbox in the current workspace.", row{}, nil, false,
		func(ctx context.Context, _ row, _ string) (any, error) { return k.get(ctx, "/api/inbox") })
	k.tool("update_inbox_item", "Mark an inbox notification read/unread, or archive/unarchive it.",
		row{"id": sID, "action": enum("read", "unread", "archive", "unarchive")}, []string{"id", "action"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			id, action := str(in, "id"), str(in, "action")
			path := "/api/inbox"
			if action == "unarchive" {
				path = "/api/inbox/archived"
			}
			v, err := k.get(ctx, path)
			if err != nil {
				return nil, err
			}
			inbox, err := asRows(v)
			if err != nil {
				return nil, err
			}
			found := false
			for _, e := range inbox {
				ws, has := e["workspace_id"]
				found = found || (e["id"] == id && (!has || ws == nil || ws == "" || ws == k.opts.WorkspaceID))
			}
			if !found {
				return nil, errors.New("Inbox item not found in this workspace")
			}
			if _, err := k.do(ctx, http.MethodPost, "/api/inbox/"+url.PathEscape(id)+"/"+action, row{}); err != nil {
				return nil, err
			}
			return row{"id": id, "action": action, "workspace_id": k.opts.WorkspaceID}, nil
		})
	k.tool("invoke_agent", "Invoke a defined Multica agent in an official cloud chat, optionally continuing its session. Returns conversation and execution IDs, not a completed answer. Use conversation_runs and run_messages/read_context to obtain progress and results. Reading an agent definition alone does not invoke it.",
		row{"agent_id": sID, "content": row{"type": "string", "minLength": 1, "maxLength": 100000}, "session_id": sID, "model": row{"type": "string", "maxLength": 200}}, []string{"agent_id", "content"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			agent, content, session, model := str(in, "agent_id"), str(in, "content"), str(in, "session_id"), str(in, "model")
			if _, err := k.ensure(ctx, "agent", agent); err != nil {
				return nil, err
			}
			var conv row
			var err error
			if session != "" {
				if conv, err = k.ensure(ctx, "conversation", session); err != nil {
					return nil, err
				}
				if conv["agent_id"] != agent {
					return nil, errors.New("Conversation belongs to a different agent")
				}
			} else {
				title := []rune(content)
				v, err := k.do(ctx, http.MethodPost, roots["conversation"], row{"agent_id": agent, "title": string(title[:min(80, len(title))])})
				if err != nil {
					return nil, err
				}
				if conv, err = asRow(v); err != nil {
					return nil, err
				}
			}
			identity, _ := conv["id"].(string)
			if !idPattern.MatchString(identity) {
				return nil, errors.New("The server did not confirm a conversation")
			}
			body := row{"content": content}
			if model != "" {
				body["model"] = model
			}
			v, err := k.do(ctx, http.MethodPost, roots["conversation"]+"/"+url.PathEscape(identity)+"/messages", body)
			result, _ := v.(row)
			task, _ := result["task_id"].(string)
			if err == nil && !idPattern.MatchString(task) {
				err = errors.New("The server did not confirm an execution ID")
			}
			if err != nil {
				return nil, fmt.Errorf("Conversation %s exists, but execution submission was not confirmed. Read it before retrying. %v", identity, err)
			}
			out := row{"conversation_id": identity}
			for key, value := range result {
				out[key] = value
			}
			out["status"], out["note"] = "submitted", "Submission is not completion. Poll conversation_runs, then read_context or run_messages."
			return out, nil
		})
	k.tool("conversation_runs", "Read actual queued/running/completed executions for an official chat, including parallel agent recipients. Follow next_cursor with before. Does not invoke a model.",
		row{"session_id": sID, "limit": sLimit, "before": row{"type": "string", "maxLength": 4096}}, []string{"session_id"}, false,
		func(ctx context.Context, in row, _ string) (any, error) {
			session := str(in, "session_id")
			if _, err := k.ensure(ctx, "conversation", session); err != nil {
				return nil, err
			}
			v, err := k.get(ctx, query(roots["conversation"]+"/"+url.PathEscape(session)+"/tasks", row{"limit": num(in, "limit", 25), "before": str(in, "before")}))
			if err != nil {
				return nil, err
			}
			if list, ok := v.([]any); ok {
				return row{"items": list, "has_more": false, "next_cursor": nil}, nil
			}
			return v, nil
		})
	runSchema := row{"run_id": sID, "conversation_id": sID, "task_id": sID, "runs_before": row{"type": "string", "maxLength": 4096}}
	k.tool("run_messages", "Read saved observable output for a specific official execution. Supply its owning conversation or task; runs_before locates older run-list pages. Continue message pages with next_seq as since_seq. Internal thinking is omitted.",
		props(runSchema, row{"limit": row{"type": "integer", "minimum": 1, "maximum": 100, "default": 50}, "since_seq": row{"type": "integer", "minimum": 0, "default": 0}}), []string{"run_id"}, false,
		func(ctx context.Context, in row, _ string) (any, error) {
			run := str(in, "run_id")
			if err := k.ensureRun(ctx, run, str(in, "conversation_id"), str(in, "task_id"), str(in, "runs_before")); err != nil {
				return nil, err
			}
			v, err := k.get(ctx, query("/api/tasks/"+url.PathEscape(run)+"/messages", row{"since": num(in, "since_seq", 0)}))
			if err != nil {
				return nil, err
			}
			all, err := asRows(v)
			if err != nil {
				return nil, err
			}
			var visible []row
			for _, m := range all {
				if m["type"] != "thinking" {
					visible = append(visible, m)
				}
			}
			limit := num(in, "limit", 50)
			items := visible[:min(limit, len(visible))]
			more := len(visible) > len(items)
			var next any
			if more && len(items) > 0 {
				next = items[len(items)-1]["seq"]
			}
			if items == nil {
				items = []row{}
			}
			return row{"items": items, "has_more": more, "next_seq": next}, nil
		})
	k.tool("cancel_run", "Cancel an official agent execution at the user's request. Supply its owning conversation or task, and runs_before for an older run-list page. This does not manage or stop its runtime.",
		runSchema, []string{"run_id"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			run := str(in, "run_id")
			if err := k.ensureRun(ctx, run, str(in, "conversation_id"), str(in, "task_id"), str(in, "runs_before")); err != nil {
				return nil, err
			}
			if _, err := k.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(run)+"/cancel", row{}); err != nil {
				return nil, err
			}
			return row{"id": run, "status": "cancellation_requested", "workspace_id": k.opts.WorkspaceID}, nil
		})
	k.tool("delete_workspace_item", "Delete a task, project, squad, Skill, automation or official chat only when the user explicitly requests deletion. Read first and supply its exact current title/name. Agents use reversible archive_agent instead. Deletion can be permanent.",
		row{"kind": enum("task", "project", "squad", "skill", "autopilot", "conversation"), "id": sID, "expected_name": sShort}, []string{"kind", "id", "expected_name"}, true,
		func(ctx context.Context, in row, _ string) (any, error) {
			kind, id := str(in, "kind"), str(in, "id")
			value, err := k.ensure(ctx, kind, id)
			if err != nil {
				return nil, err
			}
			name, _ := value["title"].(string)
			if name == "" {
				name, _ = value["name"].(string)
			}
			if name != str(in, "expected_name") {
				return nil, errors.New("The current name does not match; read the resource again before deleting")
			}
			if _, err := k.do(ctx, http.MethodDelete, roots[kind]+"/"+url.PathEscape(id), nil); err != nil {
				return nil, err
			}
			return k.receipt(ctx, kind, "deleted", row{"id": id}, "")
		})
}
