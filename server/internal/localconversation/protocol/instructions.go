package protocol

import _ "embed"

// HTMLPreviewInstructions tell providers how to produce previews the
// conversation GUI renders. The GUI owns the text
// (packages/tutti-agent-gui-host/src/html-preview-contract.ts); a test
// there keeps this copy identical.
//
//go:embed html-preview-instructions.txt
var HTMLPreviewInstructions string
