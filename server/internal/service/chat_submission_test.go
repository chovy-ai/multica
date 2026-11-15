package service

import (
	"bytes"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestChatSubmissionFingerprintIncludesModelOverride(t *testing.T) {
	session := db.ChatSession{}
	empty := pgtype.UUID{}
	fingerprint := func(options ...DirectChatSendOptions) []byte {
		return newChatSubmission(session, empty, "same prompt", nil, "member", empty, empty, options...).fingerprint
	}
	first, second := "model-a", "model-b"
	if !bytes.Equal(fingerprint(), fingerprint(DirectChatSendOptions{})) {
		t.Fatal("omitted options must retain the default submission fingerprint")
	}
	explicit := fingerprint(DirectChatSendOptions{Model: &first})
	if bytes.Equal(explicit, fingerprint()) || bytes.Equal(explicit, fingerprint(DirectChatSendOptions{Model: &second})) {
		t.Fatal("changing the requested model must conflict with the accepted payload")
	}
}
