// Package workspace gives local executions explicit Multica business
// tools: tasks, projects, defined agents, squads, Skills, automations,
// inbox, and local and cloud conversations. There is no arbitrary HTTP,
// shell, filesystem or runtime control; every resource is checked to
// belong to the selected workspace before it is changed.
package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
)

type row = map[string]any

// Requester performs authenticated workspace API calls.
type Requester interface {
	Request(ctx context.Context, method, path string, body any) (any, error)
}

// toolkit holds what every tool of one execution shares.
type toolkit struct {
	opts  Options
	mu    sync.Mutex
	ws    row
	write map[string]*writeResult
	tools []contextmcp.Tool
}

type writeResult struct {
	input string
	done  chan struct{}
	value any
	err   error
}

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)

// Schema fragments shared by the tools.
var (
	sID       = row{"type": "string", "minLength": 1, "maxLength": 200, "pattern": `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`}
	sShort    = row{"type": "string", "minLength": 1, "maxLength": 256, "pattern": `\S`}
	sText     = row{"type": "string", "maxLength": 100000}
	sNullID   = row{"anyOf": []any{sID, row{"type": "null"}}}
	sDate     = row{"anyOf": []any{row{"type": "string", "pattern": `^\d{4}-\d{2}-\d{2}$`}, row{"type": "null"}}}
	sBool     = row{"type": "boolean"}
	sLimit    = row{"type": "integer", "minimum": 1, "maximum": 100, "default": 25}
	sOffset   = row{"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0}
	sRequest  = row{"type": "string", "minLength": 1, "maxLength": 128, "pattern": `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`, "description": "Stable operation ID. Reuse it with identical arguments after a retry; use a new ID for a new action."}
	sSource   = row{"enum": []any{"local", "cloud"}, "default": "local"}
	sAssignee = row{"anyOf": []any{row{"enum": []any{"member", "agent", "squad"}}, row{"type": "null"}}}
)

func enum(values ...string) row {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return row{"enum": out}
}

func array(items row, max int) row { return row{"type": "array", "items": items, "maxItems": max} }

func props(groups ...row) row {
	out := row{}
	for _, g := range groups {
		for k, v := range g {
			out[k] = v
		}
	}
	return out
}

// tool registers a tool. Writes take a request_id: a retry with the same
// id and arguments returns the first outcome, failures included, so an
// uncertain write is never repeated.
func (k *toolkit) tool(name, description string, properties row, required []string, write bool, run func(ctx context.Context, in row, requestID string) (any, error)) {
	if write {
		properties = props(properties, row{"request_id": sRequest})
		required = append(append([]string{}, required...), "request_id")
	}
	schemaDoc := row{"type": "object", "additionalProperties": false, "properties": properties}
	if len(required) > 0 {
		schemaDoc["required"] = required
	}
	raw, _ := json.Marshal(schemaDoc)
	compiler := jsonschema.NewCompiler()
	doc, _ := jsonschema.UnmarshalJSON(strings.NewReader(string(raw)))
	if err := compiler.AddResource(name+".json", doc); err != nil {
		panic(err)
	}
	schema := compiler.MustCompile(name + ".json")
	k.tools = append(k.tools, contextmcp.Tool{
		Name: name, Description: description, InputSchema: raw, ReadOnly: !write,
		Call: func(ctx context.Context, args json.RawMessage) (contextmcp.Result, error) {
			if len(args) == 0 || string(args) == "null" {
				args = json.RawMessage(`{}`)
			}
			inst, err := jsonschema.UnmarshalJSON(strings.NewReader(string(args)))
			if err != nil {
				return contextmcp.Result{}, errors.New("invalid tool arguments")
			}
			if err := schema.Validate(inst); err != nil {
				return contextmcp.Result{}, fmt.Errorf("invalid tool arguments: %v", err)
			}
			var in row
			_ = json.Unmarshal(args, &in)
			requestID, _ := in["request_id"].(string)
			delete(in, "request_id")
			value, err := k.perform(ctx, name, in, requestID, write, run)
			if err != nil {
				return contextmcp.Result{}, err
			}
			return contextmcp.Result{Value: clean(plain(value))}, nil
		},
	})
}

func (k *toolkit) perform(ctx context.Context, name string, in row, requestID string, write bool, run func(context.Context, row, string) (any, error)) (any, error) {
	if !write {
		return run(ctx, in, requestID)
	}
	input, _ := json.Marshal(in)
	key := name + ":" + requestID
	k.mu.Lock()
	prior := k.write[key]
	if prior == nil {
		prior = &writeResult{input: string(input), done: make(chan struct{})}
		k.write[key] = prior
		k.mu.Unlock()
		prior.value, prior.err = run(ctx, in, requestID)
		close(prior.done)
		return prior.value, prior.err
	}
	k.mu.Unlock()
	if prior.input != string(input) {
		return nil, errors.New("This request_id already belongs to a different operation")
	}
	select {
	case <-prior.done:
		return prior.value, prior.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

var (
	secretKey  = regexp.MustCompile(`(?i)(?:^|_)(?:token|secret|password|credentials?)(?:$|_)`)
	privateKey = regexp.MustCompile(`(?i)^(custom_env|mcp_config|runtime_config|custom_args|system_instructions|system_prompt|authorization|headers|env|api_key|webhook_path|webhook_url|remote_mcp_connections|plugin_hook_tools)$`)
)

// plain turns typed values into JSON maps and lists, so clean sees every
// field.
func plain(v any) any {
	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out any
	_ = json.Unmarshal(data, &out)
	return out
}

// clean drops credentials, private runtime configuration and hidden
// thinking from a response.
func clean(v any) any {
	switch v := v.(type) {
	case []any:
		out := make([]any, 0, len(v))
		for _, e := range v {
			if m, ok := e.(row); ok && m["type"] == "thinking" {
				continue
			}
			out = append(out, clean(e))
		}
		return out
	case row:
		out := row{}
		for key, e := range v {
			if secretKey.MatchString(key) || privateKey.MatchString(key) {
				continue
			}
			out[key] = clean(e)
		}
		return out
	}
	return v
}

func asRow(v any) (row, error) {
	m, ok := v.(row)
	if !ok {
		return nil, errors.New("Multica returned an invalid object")
	}
	return m, nil
}

func asRows(v any) ([]row, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, errors.New("Multica returned an invalid list")
	}
	out := make([]row, len(list))
	for i, e := range list {
		m, err := asRow(e)
		if err != nil {
			return nil, err
		}
		out[i] = m
	}
	return out, nil
}

// query appends the non-empty values as URL parameters, sorted by name.
func query(path string, values row) string {
	params := url.Values{}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		switch v := values[key].(type) {
		case nil:
		case string:
			if v != "" {
				params.Set(key, v)
			}
		default:
			params.Set(key, fmt.Sprint(v))
		}
	}
	if len(params) == 0 {
		return path
	}
	return path + "?" + params.Encode()
}

func nonempty(in row) (row, error) {
	if len(in) == 0 {
		return nil, errors.New("Supply at least one field to update")
	}
	return in, nil
}

func str(in row, key string) string {
	s, _ := in[key].(string)
	return s
}

func num(in row, key string, def int) int {
	if f, ok := in[key].(float64); ok {
		return int(f)
	}
	return def
}

func boolean(in row, key string) (bool, bool) {
	b, ok := in[key].(bool)
	return b, ok
}

// without returns in minus keys.
func without(in row, keys ...string) row {
	out := row{}
	for k, v := range in {
		out[k] = v
	}
	for _, k := range keys {
		delete(out, k)
	}
	return out
}
