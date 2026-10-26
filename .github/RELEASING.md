# Release runbook

## Normal release

Release from a reviewed commit on `main` by creating and pushing a new semantic
version tag such as `v0.18.4`. The Release workflow intentionally has no manual
trigger: a tag push is the only event that can publish binaries, Homebrew
formulae, and container images.

The verification job runs the Go tests and `govulncheck` before any publishing
job starts. The vulnerability scan is fail-closed by default.

CI and release jobs require Go `~1.27.3`: at least 1.27.3, while accepting
newer 1.27 patches. This security floor is independent of the development
minimum in `server/go.mod`. A plain `1.27.x` can resolve to an older patch
while the `setup-go` version manifest catches up with an official Go release.
When raising the security floor, update all Go workflows and the pinned
Go builder image in `Dockerfile` together so shipped binaries also receive
the fixes.

## macOS trial builds

Use **Actions → macOS Desktop Build → Run workflow** to build a selected branch.
Choose `arm64` for Apple Silicon, `x64` for Intel, or `both` (the default).
Each architecture builds on a matching GitHub-hosted Mac runner. This manual
workflow only packages macOS; it does not run the tag-based Release workflow.

For the personal fork, the equivalent CLI command is:

```sh
gh workflow run desktop-smoke.yml --repo chovy-ai/multica --ref main -f architecture=both
```

When the run finishes, download `multica-macos-<architecture>-<run number>` from
its **Artifacts** section. It contains a DMG, a ZIP, `SHA256SUMS.txt`, and
`build-info.txt` identifying the source commit. Artifacts are retained for
14 days. Verify a download after extracting the artifact archive with
`shasum -a 256 -c SHA256SUMS.txt`, then open the DMG to install the app.

These trial builds use ad-hoc signing and are not notarized. No Apple
credentials or publishing token are required; macOS may require explicit
approval to open the downloaded app. The embedded updater targets the repository
that ran the workflow instead of the upstream repository. The workflow uploads
build artifacts only: it does not create a GitHub Release or publish an update
feed. Developer ID signing and notarization remain part of the separate formal
release process.

The workflow verifies vendor integrity, packaging scripts, and installer
archives. These checks do not replace the full test and typecheck CI workflow.

## Emergency vulnerability-scan bypass

Use the bypass only when `govulncheck` itself or its live vulnerability database
is unavailable, or when maintainers have documented a confirmed false positive
that blocks an urgent release. Never use it to publish a release with an
unresolved reachable vulnerability.

1. Record the reason and maintainer approval in the release issue or pull
   request, and confirm no other release is in progress.
2. In **Settings → Secrets and variables → Actions → Variables**, set the
   repository variable `ALLOW_VULN_BYPASS_FOR_TAG` to the exact release tag,
   for example `v0.18.4`.
3. Re-run the failed Release workflow for that tag. A different tag, an empty
   value, or any typo keeps the scan enabled.
4. Confirm the verification log contains the explicit bypass warning and retain
   the workflow URL in the incident record.
5. Delete `ALLOW_VULN_BYPASS_FOR_TAG` immediately after the release run
   completes. The tag-scoped value prevents a concurrent release with another
   tag from inheriting the bypass.

Every Go binary retains its compiler version in the standard Go build metadata;
use `go version -m <binary>` when auditing a downloaded release artifact.
