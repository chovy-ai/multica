package execenv

import (
	"strings"
	"testing"
)

func TestMemorySectionLastForEveryProvider(t *testing.T) {
	for _, provider := range []string{"claude", "codex", "hermes", "opencode", "cursor", "kiro", "gemini"} {
		t.Run(provider, func(t *testing.T) {
			ctx := TaskContextForEnv{}
			original := buildMetaSkillContent(provider, ctx)
			ctx.MemorySection = "## Memory\nFrozen snapshot\n"
			with := buildMetaSkillContent(provider, ctx)
			if with != original+"\n"+ctx.MemorySection || !strings.HasSuffix(with, ctx.MemorySection) {
				t.Fatal("memory section must append without changing the existing brief")
			}
		})
	}
}
