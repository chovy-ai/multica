package localhost

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// SidecarStatus is reported to Desktop in hello and sidecarStatus.
type SidecarStatus string

const (
	StatusIdle        SidecarStatus = "idle"
	StatusStarting    SidecarStatus = "starting"
	StatusReady       SidecarStatus = "ready"
	StatusCrashed     SidecarStatus = "crashed"
	StatusDraining    SidecarStatus = "draining"
	StatusUnsupported SidecarStatus = "unsupported"
)

// Command is how to start one sidecar process.
type Command struct {
	Path string
	Args []string
	Env  []string
}

// SidecarCommand runs the packaged entry with Electron in Node mode. The
// daemon's own ELECTRON_* variables are dropped so Desktop's Electron
// configuration never leaks into the sidecar.
func SidecarCommand(s Sidecar) Command {
	env := []string{"ELECTRON_RUN_AS_NODE=1"}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "ELECTRON_") {
			env = append(env, kv)
		}
	}
	return Command{Path: s.Electron, Args: []string{s.Entry}, Env: env}
}

// InitParams is sent once to each new sidecar instance.
type InitParams struct {
	Instance        string `json:"instance"`
	ProtocolVersion int    `json:"protocolVersion"`
	DataDir         string `json:"dataDir"`
	ProfileDir      string `json:"profileDir"`
	CLIPath         string `json:"cliPath"`
}

type supervisorHooks struct {
	// handle serves sidecar → daemon requests and notifications.
	handle func(ctx context.Context, instance, method string, params json.RawMessage) (any, error)
	// status is called on every lifecycle transition.
	status func(SidecarStatus, string)
	// wantRestart reports whether a crashed sidecar should come back on its own.
	wantRestart func() bool
}

const (
	minRestartBackoff = time.Second
	maxRestartBackoff = time.Minute
	stopTimeout       = 10 * time.Second
	exitWaitTimeout   = 5 * time.Second
)

// supervisor owns at most one sidecar process at a time.
type supervisor struct {
	cmd    Command
	init   InitParams
	hooks  supervisorHooks
	logger *slog.Logger

	mu         sync.Mutex
	status     SidecarStatus
	instance   string
	conn       *Conn
	proc       *exec.Cmd
	exited     chan struct{}
	starting   chan struct{}
	startErr   error
	stopping   bool
	backoff    time.Duration
	startedAt  time.Time
	restartTmr *time.Timer

	busy    atomic.Int64
	crashes atomic.Int64
}

func newSupervisor(cmd Command, init InitParams, hooks supervisorHooks, logger *slog.Logger) *supervisor {
	return &supervisor{cmd: cmd, init: init, hooks: hooks, logger: logger, status: StatusIdle, backoff: minRestartBackoff}
}

func (s *supervisor) Status() (SidecarStatus, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status, s.instance
}

// Busy is the sidecar's last reported count of work a restart would interrupt.
func (s *supervisor) Busy() int64 { return s.busy.Load() }

func (s *supervisor) Crashes() int64 { return s.crashes.Load() }

func (s *supervisor) setStatus(status SidecarStatus) {
	s.status = status
	instance := s.instance
	if s.hooks.status != nil {
		go s.hooks.status(status, instance)
	}
}

// Ensure returns a ready connection, starting the sidecar if needed.
func (s *supervisor) Ensure(ctx context.Context) (*Conn, error) {
	for {
		s.mu.Lock()
		if s.stopping {
			s.mu.Unlock()
			return nil, AppError("sidecar_stopping", "The local conversation service is stopping")
		}
		if s.conn != nil && s.status != StatusStarting {
			conn := s.conn
			s.mu.Unlock()
			return conn, nil
		}
		wait := s.starting
		if wait == nil {
			wait = make(chan struct{})
			s.starting = wait
			s.mu.Unlock()
			err := s.start()
			s.mu.Lock()
			s.startErr = err
			s.starting = nil
			close(wait)
			s.mu.Unlock()
			if err != nil {
				return nil, err
			}
			continue
		}
		s.mu.Unlock()
		select {
		case <-wait:
			s.mu.Lock()
			err := s.startErr
			s.mu.Unlock()
			if err != nil {
				return nil, err
			}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func newInstanceID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func (s *supervisor) start() error {
	proc := exec.Command(s.cmd.Path, s.cmd.Args...)
	proc.Env = s.cmd.Env
	proc.Dir = s.init.DataDir
	if err := os.MkdirAll(s.init.DataDir, 0o700); err != nil {
		return fmt.Errorf("create local conversation data dir: %w", err)
	}
	stdin, err := proc.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := proc.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := proc.StderrPipe()
	if err != nil {
		return err
	}
	instance := newInstanceID()
	s.mu.Lock()
	s.instance = instance
	s.setStatus(StatusStarting)
	s.mu.Unlock()
	if err := proc.Start(); err != nil {
		s.mu.Lock()
		s.instance = ""
		s.setStatus(StatusCrashed)
		s.mu.Unlock()
		return fmt.Errorf("start local conversation service: %w", err)
	}
	go s.logStderr(stderr)

	conn := NewConn(newLineTransport(stdout, stdin, nil), func(ctx context.Context, method string, params json.RawMessage) (any, error) {
		if method == "busy" {
			var p BusyParams
			if json.Unmarshal(params, &p) == nil {
				s.busy.Store(p.Count)
			}
			return nil, nil
		}
		if s.hooks.handle == nil {
			return nil, &RPCError{Code: rpcMethodNotFound, Message: "method not found: " + method}
		}
		return s.hooks.handle(ctx, instance, method, params)
	})
	exited := make(chan struct{})
	s.mu.Lock()
	s.proc, s.conn, s.exited = proc, conn, exited
	s.startedAt = time.Now()
	s.mu.Unlock()
	go func() {
		err := proc.Wait()
		_ = conn.Close()
		close(exited)
		s.onExit(instance, err)
	}()

	init := s.init
	init.Instance = instance
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := conn.Call(ctx, "init", init, nil); err != nil {
		_ = proc.Process.Kill()
		return fmt.Errorf("initialize local conversation service: %w", err)
	}
	s.mu.Lock()
	if s.instance == instance && s.status == StatusStarting {
		s.setStatus(StatusReady)
	}
	s.mu.Unlock()
	return nil
}

func (s *supervisor) logStderr(r interface{ Read([]byte) (int, error) }) {
	scanner := bufio.NewScanner(r)
	const maxStderrLineBytes = 1 << 20
	scanner.Buffer(make([]byte, 64<<10), maxStderrLineBytes)
	for scanner.Scan() {
		s.logger.Info("local host", "stderr", scanner.Text())
	}
}

func (s *supervisor) onExit(instance string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.instance != instance {
		return
	}
	s.conn, s.proc = nil, nil
	s.busy.Store(0)
	if s.stopping {
		s.instance = ""
		s.setStatus(StatusIdle)
		return
	}
	s.crashes.Add(1)
	s.logger.Warn("local conversation service exited", "error", err)
	if time.Since(s.startedAt) > maxRestartBackoff {
		s.backoff = minRestartBackoff
	}
	delay := s.backoff
	s.backoff = min(s.backoff*2, maxRestartBackoff)
	s.instance = ""
	s.setStatus(StatusCrashed)
	s.restartTmr = time.AfterFunc(delay, func() {
		if s.hooks.wantRestart != nil && !s.hooks.wantRestart() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if _, err := s.Ensure(ctx); err != nil {
			s.logger.Warn("local conversation service restart failed", "error", err)
		}
	})
}

// Drain stops the sidecar from starting new work and reports what is still
// running. A sidecar that is not running is idle.
func (s *supervisor) Drain(ctx context.Context) (int64, error) {
	s.mu.Lock()
	conn := s.conn
	if conn != nil && s.status == StatusReady {
		s.setStatus(StatusDraining)
	}
	s.mu.Unlock()
	if conn == nil {
		return 0, nil
	}
	var out DrainResult
	if err := conn.Call(ctx, "drain", struct{}{}, &out); err != nil {
		return 0, err
	}
	s.busy.Store(out.Busy)
	return out.Busy, nil
}

// Undrain lets a drained sidecar accept work again.
func (s *supervisor) Undrain(ctx context.Context) error {
	s.mu.Lock()
	conn := s.conn
	if conn != nil && s.status == StatusDraining {
		s.setStatus(StatusReady)
	}
	s.mu.Unlock()
	if conn == nil {
		return nil
	}
	return conn.Call(ctx, "undrain", struct{}{}, nil)
}

// Stop asks the sidecar to persist and exit, then closes its stdin and kills
// it if it lingers. After Stop, Ensure may start a fresh instance again.
func (s *supervisor) Stop(ctx context.Context) error {
	s.mu.Lock()
	if s.restartTmr != nil {
		s.restartTmr.Stop()
	}
	conn, proc, exited := s.conn, s.proc, s.exited
	if conn == nil {
		s.mu.Unlock()
		return nil
	}
	s.stopping = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.stopping = false
		s.mu.Unlock()
	}()

	callCtx, cancel := context.WithTimeout(ctx, stopTimeout)
	_ = conn.Call(callCtx, "shutdown", struct{}{}, nil)
	cancel()
	_ = conn.Close()
	select {
	case <-exited:
		return nil
	case <-time.After(exitWaitTimeout):
	}
	if proc != nil && proc.Process != nil {
		_ = proc.Process.Kill()
	}
	select {
	case <-exited:
		return nil
	case <-time.After(exitWaitTimeout):
		return errors.New("local conversation service did not exit")
	}
}
