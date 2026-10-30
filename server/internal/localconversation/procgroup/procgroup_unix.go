//go:build !windows

// Package procgroup runs a short-lived provider CLI in its own process
// group, so stopping it also stops the processes it started.
package procgroup

import (
	"os/exec"
	"syscall"
)

// Own puts the unstarted command in its own process group.
func Own(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// Kill kills the started command's process group.
func Kill(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
