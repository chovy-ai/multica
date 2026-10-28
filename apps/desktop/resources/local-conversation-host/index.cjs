// The multica daemon locates this file through manifest.json, which sits next
// to the bundled CLI in app.asar.unpacked/resources, and runs it with this
// app's Electron in Node mode. The conversation host itself and its
// dependencies stay inside app.asar, which Electron's Node mode can read.
require(require("node:path").join(__dirname, "..", "..", "..", "app.asar", "out", "main", "local-conversation-host.js"));
