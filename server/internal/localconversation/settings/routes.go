package settings

import (
	"net/http"
	"net/url"
)

// Scope is the account and workspace a Settings call acts for.
type Scope struct {
	WorkspaceID string `json:"workspace_id"`
	UserID      string `json:"user_id"`
}

// Call is one workspace API request.
type Call struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   any    `json:"body,omitempty"`
}

type route struct {
	request func(Scope, map[string]any) *Call
	before  func(Scope, map[string]any) *Call
}

func get(path string) *Call                    { return &Call{Method: http.MethodGet, Path: path} }
func do(method, path string, body any) *Call   { return &Call{Method: method, Path: path, Body: body} }
func ws(s Scope) string                        { return "/api/workspaces/" + url.PathEscape(s.WorkspaceID) }
func enc(in map[string]any, key string) string { return url.PathEscape(fmtValue(in[key])) }
func fixed(path string) func(Scope, map[string]any) *Call {
	return func(Scope, map[string]any) *Call { return get(path) }
}

func fmtValue(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case nil:
		return ""
	}
	return ""
}

func without(in map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		out[k] = v
	}
	for _, k := range keys {
		delete(out, k)
	}
	return out
}

func merged(a map[string]any, b any) map[string]any {
	out := without(a)
	if m, ok := b.(map[string]any); ok {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

func connectionPath(s Scope, in map[string]any) string {
	provider := fmtValue(in["provider"])
	kind := "installations"
	if provider == "vcs" {
		kind = "connections"
	}
	return ws(s) + "/" + url.PathEscape(provider) + "/" + kind
}

// hostOnly operations are performed by the Desktop host.
var hostOnly = map[string]bool{
	"settings_open": true, "settings_read_device": true, "settings_update_device": true,
	"settings_set_shortcut": true, "settings_device_action": true,
}

// routes are the API calls of each operation, by name. Operations in
// hostOnly have none.
var routes = map[string]route{
	"settings_read_workspace": {request: func(s Scope, _ map[string]any) *Call { return get(ws(s)) }},
	"settings_update_workspace": {
		request: func(s Scope, in map[string]any) *Call { return do(http.MethodPatch, ws(s), in["fields"]) },
		before:  func(s Scope, _ map[string]any) *Call { return get(ws(s)) }},
	"settings_list_members": {request: func(s Scope, in map[string]any) *Call {
		if in["invitations"] == true {
			return get(ws(s) + "/invitations")
		}
		return get(ws(s) + "/members")
	}},
	"settings_invite_member": {request: func(s Scope, in map[string]any) *Call { return do(http.MethodPost, ws(s)+"/members", in) }},
	"settings_update_member": {
		request: func(s Scope, in map[string]any) *Call {
			return do(http.MethodPatch, ws(s)+"/members/"+enc(in, "id"), map[string]any{"role": in["role"]})
		},
		before: func(s Scope, _ map[string]any) *Call { return get(ws(s) + "/members") }},
	"settings_remove_member": {
		request: func(s Scope, in map[string]any) *Call {
			return do(http.MethodDelete, ws(s)+"/members/"+enc(in, "id"), nil)
		},
		before: func(s Scope, _ map[string]any) *Call { return get(ws(s) + "/members") }},
	"settings_revoke_invitation": {
		request: func(s Scope, in map[string]any) *Call {
			return do(http.MethodDelete, ws(s)+"/invitations/"+enc(in, "id"), nil)
		},
		before: func(s Scope, _ map[string]any) *Call { return get(ws(s) + "/invitations") }},

	"settings_list_workflows":  {request: fixed("/api/issue-workflows")},
	"settings_read_workflow":   {request: func(_ Scope, in map[string]any) *Call { return get("/api/issue-workflows/" + enc(in, "id")) }},
	"settings_create_workflow": {request: func(_ Scope, in map[string]any) *Call { return do(http.MethodPost, "/api/issue-workflows", in) }},
	"settings_preview_workflow": {request: func(_ Scope, in map[string]any) *Call {
		return do(http.MethodPatch, "/api/issue-workflows/"+enc(in, "id"), merged(map[string]any{"dry_run": true}, in["fields"]))
	}},
	"settings_update_workflow": {
		request: func(_ Scope, in map[string]any) *Call {
			body := merged(map[string]any{}, in["fields"])
			body["dry_run"] = false
			return do(http.MethodPatch, "/api/issue-workflows/"+enc(in, "id"), body)
		},
		before: func(_ Scope, in map[string]any) *Call { return get("/api/issue-workflows/" + enc(in, "id")) }},
	"settings_delete_workflow": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodDelete, "/api/issue-workflows/"+enc(in, "id"), nil)
		},
		before: func(_ Scope, in map[string]any) *Call { return get("/api/issue-workflows/" + enc(in, "id")) }},
	"settings_set_workflow_handoff": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodPut, "/api/issue-workflows/"+enc(in, "id")+"/handoffs/"+enc(in, "status_key"), without(in, "id", "status_key"))
		},
		before: func(_ Scope, in map[string]any) *Call { return get("/api/issue-workflows/" + enc(in, "id")) }},
	"settings_preview_workflow_brief": {request: func(_ Scope, in map[string]any) *Call {
		return do(http.MethodPost, "/api/issue-workflows/"+enc(in, "id")+"/brief", without(in, "id"))
	}},
	"settings_set_project_workflow": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodPost, "/api/projects/"+enc(in, "project_id")+"/workflow", without(in, "project_id"))
		},
		before: func(_ Scope, in map[string]any) *Call { return get("/api/projects/" + enc(in, "project_id")) }},

	"settings_list_statuses": {request: func(_ Scope, in map[string]any) *Call {
		return get("/api/issue-statuses?include_archived=" + fmtValue(in["include_archived"]))
	}},
	"settings_create_status": {request: func(_ Scope, in map[string]any) *Call { return do(http.MethodPost, "/api/issue-statuses", in) }},
	"settings_update_status": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodPatch, "/api/issue-statuses/"+enc(in, "id"), in["fields"])
		},
		before: fixed("/api/issue-statuses?include_archived=true")},
	"settings_reorder_statuses": {request: func(_ Scope, in map[string]any) *Call { return do(http.MethodPatch, "/api/issue-statuses/reorder", in) }},
	"settings_archive_status": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodDelete, "/api/issue-statuses/"+enc(in, "id"), nil)
		},
		before: fixed("/api/issue-statuses?include_archived=true")},
	"settings_list_wakeups": {request: fixed("/api/system-wakeups")},
	"settings_update_wakeup": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodPut, "/api/system-wakeups/"+enc(in, "rule"), in["fields"])
		},
		before: fixed("/api/system-wakeups")},
	"settings_list_labels": {request: func(_ Scope, in map[string]any) *Call {
		return get("/api/labels?resource_type=" + url.QueryEscape(fmtValue(in["resource_type"])))
	}},
	"settings_create_label": {request: func(_ Scope, in map[string]any) *Call { return do(http.MethodPost, "/api/labels", in) }},
	"settings_update_label": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodPut, "/api/labels/"+enc(in, "id"), in["fields"])
		},
		before: func(_ Scope, in map[string]any) *Call { return get("/api/labels/" + enc(in, "id")) }},
	"settings_delete_label": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodDelete, "/api/labels/"+enc(in, "id"), nil)
		},
		before: func(_ Scope, in map[string]any) *Call { return get("/api/labels/" + enc(in, "id")) }},
	"settings_list_properties": {request: func(_ Scope, in map[string]any) *Call {
		return get("/api/properties?include_archived=" + fmtValue(in["include_archived"]))
	}},
	"settings_create_property": {request: func(_ Scope, in map[string]any) *Call { return do(http.MethodPost, "/api/properties", in) }},
	"settings_update_property": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodPatch, "/api/properties/"+enc(in, "id"), in["fields"])
		},
		before: func(_ Scope, in map[string]any) *Call { return get("/api/properties/" + enc(in, "id")) }},
	"settings_list_quick_actions": {request: func(_ Scope, in map[string]any) *Call {
		return get("/api/quick-actions?include_archived=" + fmtValue(in["include_archived"]))
	}},
	"settings_create_quick_action": {request: func(_ Scope, in map[string]any) *Call { return do(http.MethodPost, "/api/quick-actions", in) }},
	"settings_update_quick_action": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodPatch, "/api/quick-actions/"+enc(in, "id"), in["fields"])
		},
		before: fixed("/api/quick-actions?include_archived=true")},
	"settings_delete_quick_action": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodDelete, "/api/quick-actions/"+enc(in, "id"), nil)
		},
		before: fixed("/api/quick-actions?include_archived=true")},

	"settings_list_mcp_servers": {request: func(s Scope, _ map[string]any) *Call { return get(ws(s) + "/mcp-servers") }},
	"settings_create_mcp_server": {request: func(s Scope, in map[string]any) *Call {
		return do(http.MethodPost, ws(s)+"/mcp-servers", map[string]any{"name": in["name"], "config": in["config"]})
	}},
	"settings_update_mcp_server": {
		request: func(s Scope, in map[string]any) *Call {
			return do(http.MethodPut, ws(s)+"/mcp-servers/"+enc(in, "id"), map[string]any{"config": in["config"]})
		},
		before: func(s Scope, _ map[string]any) *Call { return get(ws(s) + "/mcp-servers") }},
	"settings_rename_mcp_server": {
		request: func(s Scope, in map[string]any) *Call {
			return do(http.MethodPut, ws(s)+"/mcp-servers/"+enc(in, "id"), map[string]any{"name": in["name"]})
		},
		before: func(s Scope, _ map[string]any) *Call { return get(ws(s) + "/mcp-servers") }},
	"settings_delete_mcp_server": {
		request: func(s Scope, in map[string]any) *Call {
			return do(http.MethodDelete, ws(s)+"/mcp-servers/"+enc(in, "id"), nil)
		},
		before: func(s Scope, _ map[string]any) *Call { return get(ws(s) + "/mcp-servers") }},
	"settings_list_connections": {request: func(s Scope, in map[string]any) *Call { return get(connectionPath(s, in)) }},
	"settings_disconnect_connection": {
		request: func(s Scope, in map[string]any) *Call {
			return do(http.MethodDelete, connectionPath(s, in)+"/"+enc(in, "id"), nil)
		},
		before: func(s Scope, in map[string]any) *Call { return get(connectionPath(s, in)) }},
	"settings_update_code_settings": {
		request: func(s Scope, in map[string]any) *Call {
			return do(http.MethodPatch, ws(s), map[string]any{"settings": in["fields"]})
		},
		before: func(s Scope, _ map[string]any) *Call { return get(ws(s)) }},
	"settings_read_profile": {request: fixed("/api/me")},
	"settings_update_profile": {
		request: func(_ Scope, in map[string]any) *Call { return do(http.MethodPatch, "/api/me", in["fields"]) },
		before:  fixed("/api/me")},
	"settings_read_notifications": {request: fixed("/api/notification-preferences")},
	"settings_update_notifications": {request: func(_ Scope, in map[string]any) *Call {
		return do(http.MethodPatch, "/api/notification-preferences", in)
	}},
	"settings_list_tokens":  {request: fixed("/api/tokens")},
	"settings_create_token": {request: func(_ Scope, in map[string]any) *Call { return do(http.MethodPost, "/api/tokens", in) }},
	"settings_revoke_token": {
		request: func(_ Scope, in map[string]any) *Call {
			return do(http.MethodDelete, "/api/tokens/"+enc(in, "id"), nil)
		},
		before: fixed("/api/tokens")},
}
