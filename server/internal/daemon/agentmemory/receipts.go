package agentmemory

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

var receiptLocks sync.Map

type receipt struct {
	Path  string `json:"path"`
	Title string `json:"title"`
}
type receipts struct {
	Pending []receipt `json:"pending"`
}

func receiptLock(root string) func() {
	v, _ := receiptLocks.LoadOrStore(root, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}
func readReceipts(root string) (receipts, error) {
	var r receipts
	data, err := os.ReadFile(filepath.Join(root, ".memory_receipts.json"))
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	return r, json.Unmarshal(data, &r)
}
func RecordReceipt(root, path, title string) error {
	defer receiptLock(root)()
	r, err := readReceipts(root)
	if err != nil {
		return err
	}
	found := false
	for i := range r.Pending {
		if r.Pending[i].Path == path {
			r.Pending[i].Title = title
			found = true
			break
		}
	}
	if !found {
		r.Pending = append(r.Pending, receipt{path, title})
	}
	data, _ := json.Marshal(r)
	return AtomicWrite(filepath.Join(root, ".memory_receipts.json"), data)
}
func ClaimReceipts(root string) ([]string, error) {
	defer receiptLock(root)()
	r, err := readReceipts(root)
	if err != nil {
		return nil, err
	}
	titles := []string{}
	for _, p := range r.Pending {
		titles = append(titles, p.Title)
	}
	if err = AtomicWrite(filepath.Join(root, ".memory_receipts.json"), []byte(`{"pending":[]}`)); err != nil {
		return nil, err
	}
	return titles, nil
}
