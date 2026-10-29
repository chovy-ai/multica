// Package protocol holds the wire contracts of local conversations: the
// daemon <-> Desktop v2 protocol and the daemon <-> Claude adapter protocol.
// The JSON Schema files under schema/ are the single definition source; Go and
// TypeScript types are generated from them.
package protocol

import "embed"

// Published $id of each schema file.
const (
	LocalV2ID       = "https://multica.ai/schema/local-conversation/v2.json"
	ClaudeAdapterID = "https://multica.ai/schema/local-conversation/claude-adapter-v1.json"
)

// SchemaFiles maps each schema $id to its file in Schemas.
var SchemaFiles = map[string]string{
	LocalV2ID:       "schema/local-v2.schema.json",
	ClaudeAdapterID: "schema/claude-adapter-v1.schema.json",
}

// Schemas embeds the schema definition files.
//
//go:embed schema/*.schema.json
var Schemas embed.FS
