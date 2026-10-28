package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
)

type fakeLocalGate struct {
	busy     int64
	err      error
	drained  int
	undrains int
}

func (g *fakeLocalGate) Drain(context.Context) (int64, error) {
	g.drained++
	return g.busy, g.err
}

func (g *fakeLocalGate) Undrain(context.Context) error {
	g.undrains++
	return nil
}

func TestQuiesceForRestartDefersWhileLocalWorkRuns(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct {
		name         string
		gate         fakeLocalGate
		want         bool
		wantUndrains int
	}{
		{name: "idle restarts and stays drained", want: true},
		{name: "busy defers and resumes", gate: fakeLocalGate{busy: 1}, wantUndrains: 1},
		{name: "unresponsive defers and resumes", gate: fakeLocalGate{err: errors.New("closed")}, wantUndrains: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gate := tc.gate
			if got := quiesceForRestart(context.Background(), &gate, logger); got != tc.want {
				t.Fatalf("quiesceForRestart() = %v, want %v", got, tc.want)
			}
			if gate.drained != 1 || gate.undrains != tc.wantUndrains {
				t.Fatalf("drained=%d undrains=%d, want 1/%d", gate.drained, gate.undrains, tc.wantUndrains)
			}
		})
	}
}

func TestDaemonWithoutLocalHostNeverBlocksRestart(t *testing.T) {
	d := &Daemon{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if !d.quiesceLocalForRestart(context.Background()) {
		t.Fatal("a daemon without local conversations must not block restarts")
	}
}
