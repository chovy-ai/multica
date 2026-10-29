package daemon

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

func TestContextCloudOnlyForTheDaemonsServer(t *testing.T) {
	t.Parallel()

	d := &Daemon{cfg: Config{ServerBaseURL: "https://api.multica.ai/"}, client: NewClient("https://api.multica.ai")}
	if d.contextCloud(store.Scope{APIOrigin: "https://API.multica.ai", WorkspaceID: "w"}, t.TempDir()) == nil {
		t.Fatal("same server origin got no cloud context")
	}
	if d.contextCloud(store.Scope{APIOrigin: "https://self-hosted.example", WorkspaceID: "w"}, t.TempDir()) != nil {
		t.Fatal("another server origin got the profile's credentials")
	}
}
