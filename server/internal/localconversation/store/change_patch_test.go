package store

import (
	"github.com/multica-ai/multica/server/internal/localconversation/filechanges"
	"strings"
	"testing"
)

func TestCumulativePatchPreservesExactBytesAndBoundsRewrites(t *testing.T) {
	for _, tc := range []struct{ before, after string }{
		{"a\r\nb\r\n", "a\r\nc\r\n"}, {"a", "b"}, {"a\n", "a"}, {"", "new\n"}, {"old\n", ""}, {"keep\nold\nend", "keep\nnew\nend"},
		{strings.Repeat("context\n", 5000) + "old\n", strings.Repeat("context\n", 5000) + "new\n"},
	} {
		patch, ok := cumulativePatch(tc.before, tc.after, "a/file", "b/file")
		if !ok {
			t.Fatal("small edit unavailable")
		}
		actual, valid := filechanges.Apply(tc.before, patch, "update")
		if !valid || actual != tc.after {
			t.Fatalf("patch does not reproduce bytes: %q -> %q: %q (%q)", tc.before, tc.after, actual, patch)
		}
	}
	if _, ok := cumulativePatch(strings.Repeat("old\n", 3000), strings.Repeat("new\n", 3000), "a/file", "b/file"); ok {
		t.Fatal("unbounded rewrite accepted")
	}
}
