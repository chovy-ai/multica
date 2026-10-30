// The multica daemon starts this file once per local Claude conversation
// through manifest.json, with this app's Electron in Node mode. The adapter
// and its dependencies stay inside app.asar, which Electron's Node mode can read.
require(require("node:path").join(__dirname, "..", "..", "..", "app.asar", "out", "main", "claude-host.js"));
