package filechanges

import "testing"

func TestVerificationFailedCreateWithoutWriteHasNoChange(t *testing.T) {
	root := t.TempDir()
	c := Scan(root)
	out := c.NativeBatch("turn", []NativeChange{{OperationID: "failed-create", Path: "never-created.ts", Kind: "add", Patch: "new\n", Success: false}})
	for _, o := range out {
		if o.Path != "" {
			t.Fatalf("failed create with unchanged absent file must not appear in resources; observation=%#v", o)
		}
	}
}
