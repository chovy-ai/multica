package servicepreview

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"time"
)

type Hello struct {
	Version      int    `json:"version"`
	ServiceID    string `json:"service_id"`
	ConnectionID string `json:"connection_id"`
	Capability   string `json:"capability"`
}
type Reply struct {
	Version int      `json:"version"`
	OK      bool     `json:"ok"`
	Error   *Failure `json:"error,omitempty"`
}

func readFrame(r io.Reader, value any) error {
	var size uint32
	if err := binary.Read(r, binary.BigEndian, &size); err != nil {
		return err
	}
	if size == 0 || size > 4096 {
		return fail("invalid_request", 400)
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(r, data); err != nil {
		return err
	}
	return decode(bytes.NewReader(data), value)
}
func writeFrame(w io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > 4096 {
		return fail("invalid_request", 400)
	}
	if err := binary.Write(w, binary.BigEndian, uint32(len(data))); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// Dial returns a raw stream only after the authenticated peer connected its loopback service.
func Dial(ctx context.Context, open func(context.Context) (net.Conn, error), hello Hello) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c, err := open(ctx)
	if err != nil {
		return nil, fail("device_unreachable", 502)
	}
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	_ = c.SetDeadline(deadline)
	if err := writeFrame(c, hello); err != nil {
		c.Close()
		return nil, err
	}
	var reply Reply
	if err := readFrame(c, &reply); err != nil {
		c.Close()
		return nil, fail("preview_unsupported", 502)
	}
	if reply.Version != 1 || !reply.OK {
		c.Close()
		if reply.Error != nil {
			reply.Error.Status = 502
			return nil, reply.Error
		}
		return nil, fail("preview_unsupported", 502)
	}
	if ctx.Err() != nil {
		c.Close()
		return nil, ctx.Err()
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}
