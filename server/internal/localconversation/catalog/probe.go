// Package catalog reads what the installed provider CLIs offer: whether
// they are installed, their models, and account and context usage. It only
// initializes the CLIs and asks for catalogs; it never submits a prompt.
package catalog

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

// errNoAnswer is returned when the CLI exits or times out before answering.
var errNoAnswer = errors.New("catalog: the provider did not answer")

// probeRequest names what a probe asks after initializing.
type probeRequest struct {
	executable string
	dir        string
	env        []string
	// resume is the Claude session whose limits to read, if any.
	resume string
	// usage asks for account usage after initializing.
	usage   bool
	timeout time.Duration
}

// probeResult carries the initialize result and, when asked, the usage
// result, both as the CLI returned them.
type probeResult struct {
	initialize json.RawMessage
	usage      json.RawMessage
}

// probeClaude speaks Claude Code's stream-json control protocol: initialize
// and, when asked, get_usage.
func probeClaude(ctx context.Context, req probeRequest) (probeResult, error) {
	args := []string{"--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"}
	if req.resume != "" {
		args = append(args, "--resume", req.resume)
	}
	send := func(id int, subtype string, params map[string]any) any {
		request := map[string]any{"subtype": subtype}
		for k, v := range params {
			request[k] = v
		}
		return map[string]any{"type": "control_request", "request_id": strconv.Itoa(id), "request": request}
	}
	reply := func(line []byte) (int, json.RawMessage, error) {
		var frame struct {
			Type     string `json:"type"`
			Response struct {
				Subtype   string          `json:"subtype"`
				RequestID string          `json:"request_id"`
				Response  json.RawMessage `json:"response"`
				Error     string          `json:"error"`
			} `json:"response"`
		}
		if json.Unmarshal(line, &frame) != nil || frame.Type != "control_response" {
			return 0, nil, nil
		}
		id, _ := strconv.Atoi(frame.Response.RequestID)
		if frame.Response.Subtype != "success" {
			return id, nil, fmt.Errorf("catalog: Claude Code refused the request: %s", frame.Response.Error)
		}
		return id, frame.Response.Response, nil
	}
	next := func(id int) []any {
		if id == 1 && req.usage {
			return []any{send(2, "get_usage", map[string]any{"skip_behaviors": true})}
		}
		return nil
	}
	return runProbe(ctx, req, args, []any{send(1, "initialize", nil)}, reply, next)
}

// probeCodex speaks the Codex app-server protocol: initialize and, when
// asked, account/rateLimits/read.
func probeCodex(ctx context.Context, req probeRequest) (probeResult, error) {
	reply := func(line []byte) (int, json.RawMessage, error) {
		var frame struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(line, &frame) != nil || frame.ID == nil {
			return 0, nil, nil
		}
		if frame.Error != nil {
			return *frame.ID, nil, fmt.Errorf("catalog: Codex refused the request: %s", frame.Error.Message)
		}
		return *frame.ID, frame.Result, nil
	}
	next := func(id int) []any {
		if id == 1 && req.usage {
			return []any{map[string]any{"method": "initialized"}, map[string]any{"id": 2, "method": "account/rateLimits/read", "params": map[string]any{}}}
		}
		return nil
	}
	initialize := map[string]any{"id": 1, "method": "initialize", "params": map[string]any{
		"clientInfo": map[string]any{"name": "multica_usage", "version": "0.1.0"}, "capabilities": map[string]any{"experimentalApi": true},
	}}
	return runProbe(ctx, req, []string{"app-server"}, []any{initialize}, reply, next)
}

// runProbe starts the CLI in its own process group, writes the first
// frames, and answers each reply with next until the last expected reply.
// The process group is killed when the probe returns.
func runProbe(
	ctx context.Context, req probeRequest, args []string, first []any,
	reply func([]byte) (int, json.RawMessage, error), next func(int) []any,
) (probeResult, error) {
	ctx, cancel := context.WithTimeout(ctx, req.timeout)
	defer cancel()
	cmd := exec.Command(req.executable, args...)
	cmd.Dir = req.dir
	cmd.Env = req.env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return probeResult{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return probeResult{}, err
	}
	if err := cmd.Start(); err != nil {
		return probeResult{}, err
	}
	// Reads must finish before Wait closes stdout.
	readerDone := make(chan struct{})
	defer func() {
		_ = stdin.Close()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-readerDone
		_ = cmd.Wait()
	}()

	type answer struct {
		result probeResult
		err    error
	}
	done := make(chan answer, 1)
	write := func(frames []any) error {
		for _, f := range frames {
			data, _ := json.Marshal(f)
			if _, err := stdin.Write(append(data, '\n')); err != nil {
				return err
			}
		}
		return nil
	}
	go func() {
		defer close(readerDone)
		var result probeResult
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64<<10), 16<<20)
		for scanner.Scan() {
			id, payload, err := reply(scanner.Bytes())
			if err != nil {
				done <- answer{err: err}
				return
			}
			switch id {
			case 1:
				result.initialize = payload
				frames := next(1)
				if len(frames) == 0 {
					done <- answer{result: result}
					return
				}
				if err := write(frames); err != nil {
					done <- answer{err: errNoAnswer}
					return
				}
			case 2:
				result.usage = payload
				done <- answer{result: result}
				return
			}
		}
		done <- answer{err: errNoAnswer}
	}()
	if err := write(first); err != nil {
		return probeResult{}, errNoAnswer
	}
	select {
	case a := <-done:
		return a.result, a.err
	case <-ctx.Done():
		return probeResult{}, errNoAnswer
	}
}

// probeEnv is the daemon's environment: the CLIs find their credentials
// and configuration as they do for tasks.
func probeEnv() []string { return os.Environ() }
