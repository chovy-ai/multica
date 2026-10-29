package protocol

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func compileDef(t *testing.T, schemaID, def string) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	for id, path := range SchemaFiles {
		raw, err := Schemas.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		if err := c.AddResource(id, doc); err != nil {
			t.Fatal(err)
		}
	}
	schema, err := c.Compile(schemaID + "#/$defs/" + def)
	if err != nil {
		t.Fatalf("compile %s#%s: %v", schemaID, def, err)
	}
	return schema
}

// TestGoldenSamples validates testdata/<schema>/{valid,invalid}/<def>__<name>.json
// against the named $defs entry. Valid samples must pass and invalid samples
// must be rejected, so the schemas cannot silently loosen.
func TestGoldenSamples(t *testing.T) {
	t.Parallel()

	schemaIDs := map[string]string{"local-v2": LocalV2ID, "claude-adapter-v1": ClaudeAdapterID}
	for dir, schemaID := range schemaIDs {
		for _, outcome := range []string{"valid", "invalid"} {
			paths, err := filepath.Glob(filepath.Join("testdata", dir, outcome, "*.json"))
			if err != nil {
				t.Fatal(err)
			}
			if len(paths) == 0 {
				t.Fatalf("no %s samples for %s", outcome, dir)
			}
			for _, path := range paths {
				def, _, ok := strings.Cut(filepath.Base(path), "__")
				if !ok {
					t.Fatalf("%s: name must be <def>__<case>.json", path)
				}
				t.Run(filepath.ToSlash(path), func(t *testing.T) {
					t.Parallel()
					raw, err := os.ReadFile(path)
					if err != nil {
						t.Fatal(err)
					}
					doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
					if err != nil {
						t.Fatalf("sample is not JSON: %v", err)
					}
					err = compileDef(t, schemaID, def).Validate(doc)
					if outcome == "valid" && err != nil {
						t.Fatalf("valid sample rejected: %v", err)
					}
					if outcome == "invalid" && err == nil {
						t.Fatal("invalid sample accepted")
					}
				})
			}
		}
	}
}
