package filechanges

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNativeCollectionComposesPatchesBeforeDiskVerification(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a", "A\n")
	c := Scan(root)
	put(t, root, "a", "C\n")
	observations := Collect([]Collection{{Capture: c, TurnID: "turn", Native: []NativeChange{
		{OperationID: "one", Path: "a", Kind: "update", Patch: "@@ -1 +1 @@\n-A\n+B\n", Success: true},
		{OperationID: "two", Path: "a", Kind: "update", Patch: "@@ -1 +1 @@\n-B\n+C\n", Success: true},
	}}, {Capture: c, TurnID: "turn", Unknown: true}})
	if len(observations) != 3 || observations[0].Reason != "" || observations[1].Reason != "" || observations[0].After.Content != "B\n" || observations[1].Before.Content != "B\n" || observations[1].After.Content != "C\n" || observations[2].OperationID != "capture-end:turn" {
		t.Fatalf("unverified chain %#v", observations)
	}
}

func TestNativeRenameChainNeverTrustsAnIntermediatePathOnFinalMismatch(t *testing.T) {
	for _, external := range []bool{false, true} {
		t.Run(map[bool]string{false: "exact", true: "external"}[external], func(t *testing.T) {
			root := t.TempDir()
			put(t, root, "a", "A\n")
			c := Scan(root)
			if err := os.Rename(filepath.Join(root, "a"), filepath.Join(root, "c")); err != nil {
				t.Fatal(err)
			}
			if external {
				put(t, root, "c", "external\n")
			}
			out := c.NativeBatch("turn", []NativeChange{{OperationID: "one", Path: "a", MovePath: "b", Kind: "move", Success: true}, {OperationID: "two", Path: "b", MovePath: "c", Kind: "move", Success: true}})
			for _, o := range out {
				if (o.Reason != "") != external {
					t.Fatalf("rename chain %#v", out)
				}
			}
		})
	}
}

func TestFailedMultiFileToolCountsOnlyExactlyVerifiedWrites(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{"written", "unchanged", "partial"} {
		put(t, root, path, "A\n")
	}
	c := Scan(root)
	put(t, root, "written", "B\n")
	put(t, root, "partial", "partial\n")
	changes := []NativeChange{}
	for _, path := range []string{"written", "unchanged", "partial"} {
		changes = append(changes, NativeChange{OperationID: path, Path: path, Kind: "update", Patch: "@@ -1 +1 @@\n-A\n+B\n"})
	}
	out := c.NativeBatch("turn", changes)
	if out[0].Reason != "" || out[0].After.Content != "B\n" || out[1].Path != "" || out[2].Reason != "uncertain" {
		t.Fatalf("partial tool %#v", out)
	}
}
