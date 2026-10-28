package localhost

import (
	"bufio"
	"io"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// lineTransport frames messages as newline-delimited JSON over a pipe pair.
type lineTransport struct {
	r       *bufio.Reader
	w       io.WriteCloser
	closeFn func() error
	once    sync.Once
}

func newLineTransport(r io.Reader, w io.WriteCloser, closeFn func() error) *lineTransport {
	return &lineTransport{r: bufio.NewReaderSize(r, 64<<10), w: w, closeFn: closeFn}
}

func (t *lineTransport) ReadMessage() ([]byte, error) {
	var line []byte
	for {
		chunk, isPrefix, err := t.r.ReadLine()
		if err != nil {
			return nil, err
		}
		line = append(line, chunk...)
		if !isPrefix {
			if len(line) == 0 {
				continue
			}
			return line, nil
		}
	}
}

func (t *lineTransport) WriteMessage(data []byte) error {
	_, err := t.w.Write(append(data, '\n'))
	return err
}

func (t *lineTransport) Close() error {
	var err error
	t.once.Do(func() {
		err = t.w.Close()
		if t.closeFn != nil {
			if cerr := t.closeFn(); err == nil {
				err = cerr
			}
		}
	})
	return err
}

// wsTransport frames messages as WebSocket text messages and keeps the
// connection honest with ping/pong: two missed pongs end it.
type wsTransport struct {
	c       *websocket.Conn
	writeMu sync.Mutex
	done    chan struct{}
	once    sync.Once
}

const (
	pingInterval = 15 * time.Second
	pongWait     = 2*pingInterval + 5*time.Second
	writeWait    = 10 * time.Second
)

func newWSTransport(c *websocket.Conn) *wsTransport {
	t := &wsTransport{c: c, done: make(chan struct{})}
	_ = c.SetReadDeadline(time.Now().Add(pongWait))
	c.SetPongHandler(func(string) error { return c.SetReadDeadline(time.Now().Add(pongWait)) })
	go t.pingLoop()
	return t
}

func (t *wsTransport) pingLoop() {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-t.done:
			return
		case <-ticker.C:
			t.writeMu.Lock()
			err := t.c.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
			t.writeMu.Unlock()
			if err != nil {
				_ = t.Close()
				return
			}
		}
	}
}

func (t *wsTransport) ReadMessage() ([]byte, error) {
	for {
		kind, data, err := t.c.ReadMessage()
		if err != nil {
			return nil, err
		}
		if kind == websocket.TextMessage {
			return data, nil
		}
	}
}

func (t *wsTransport) WriteMessage(data []byte) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	_ = t.c.SetWriteDeadline(time.Now().Add(writeWait))
	return t.c.WriteMessage(websocket.TextMessage, data)
}

func (t *wsTransport) Close() error {
	t.once.Do(func() { close(t.done) })
	return t.c.Close()
}
