//go:build windows

// Package procgroup runs a short-lived provider CLI in its own process
// group, so stopping it also stops the processes it started.
package procgroup

import "os/exec"

// Own is a no-op on Windows, which has no process groups to join.
func Own(*exec.Cmd) {}

// Kill kills the started command; on Windows its descendants are not reached.
func Kill(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
