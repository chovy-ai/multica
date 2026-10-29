package service

import (
	"errors"
	"sync"
)

// MaxRunningTurns is the global limit on running turns across providers and
// conversations (plan §6.3).
const MaxRunningTurns = 20

// ErrConcurrencyLimit rejects a send while MaxRunningTurns turns run.
var ErrConcurrencyLimit = errors.New("local conversation: too many running turns")

// Limiter counts running turns.
type Limiter struct {
	mu      sync.Mutex
	limit   int
	running int
}

// NewLimiter returns a limiter allowing limit concurrent turns.
func NewLimiter(limit int) *Limiter { return &Limiter{limit: limit} }

// TryAcquire takes a slot, or reports ErrConcurrencyLimit.
func (l *Limiter) TryAcquire() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.running >= l.limit {
		return ErrConcurrencyLimit
	}
	l.running++
	return nil
}

// Release returns a slot.
func (l *Limiter) Release() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.running > 0 {
		l.running--
	}
}

// Running reports the number of running turns.
func (l *Limiter) Running() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.running
}
