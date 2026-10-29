package p2pserver

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// Device is one daemon profile's link key.
type Device struct {
	UserID     string    `json:"-"`
	DaemonID   string    `json:"daemon_id"`
	Profile    string    `json:"profile"`
	PeerID     string    `json:"peer_id"`
	PublicKey  string    `json:"public_key"`
	DeviceName string    `json:"device_name"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Store persists devices in a single SQLite file.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS device (
    user_id     TEXT NOT NULL,
    daemon_id   TEXT NOT NULL,
    profile     TEXT NOT NULL,
    peer_id     TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    device_name TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, daemon_id, profile)
);
CREATE INDEX IF NOT EXISTS device_updated_at ON device (updated_at);
`

// OpenStore opens or creates the database at path.
func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	// SQLite serializes writers; one connection avoids "database is locked".
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("p2pserver: init schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Upsert registers or refreshes a device.
func (s *Store) Upsert(ctx context.Context, d Device) (Device, error) {
	d.UpdatedAt = time.Now().UTC().Truncate(time.Millisecond)
	_, err := s.db.ExecContext(ctx, `
INSERT INTO device (user_id, daemon_id, profile, peer_id, public_key, device_name, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, daemon_id, profile) DO UPDATE SET
    peer_id = excluded.peer_id,
    public_key = excluded.public_key,
    device_name = excluded.device_name,
    updated_at = excluded.updated_at`,
		d.UserID, d.DaemonID, d.Profile, d.PeerID, d.PublicKey, d.DeviceName, d.UpdatedAt.UnixMilli())
	return d, err
}

// List returns the account's devices refreshed at or after since.
func (s *Store) List(ctx context.Context, userID string, since time.Time) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT daemon_id, profile, peer_id, public_key, device_name, updated_at
FROM device WHERE user_id = ? AND updated_at >= ?
ORDER BY daemon_id, profile`, userID, since.UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		d := Device{UserID: userID}
		var updated int64
		if err := rows.Scan(&d.DaemonID, &d.Profile, &d.PeerID, &d.PublicKey, &d.DeviceName, &updated); err != nil {
			return nil, err
		}
		d.UpdatedAt = time.UnixMilli(updated).UTC()
		out = append(out, d)
	}
	return out, rows.Err()
}

// Delete removes one device and reports whether it existed.
func (s *Store) Delete(ctx context.Context, userID, daemonID, profile string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM device WHERE user_id = ? AND daemon_id = ? AND profile = ?`, userID, daemonID, profile)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// PurgeBefore deletes devices not refreshed since cutoff.
func (s *Store) PurgeBefore(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM device WHERE updated_at < ?`, cutoff.UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
