# Conversation resources and verified file changes

Desktop’s sliders button lists the selected conversation’s changes, outputs and committed attachments. It opens a popover without changing the existing Side panel. Selecting a change reuses one Changes tab for that source conversation; Side, file, folder and web tabs keep their own state. Split diff requires the expanded workspace; narrow panes use a file drawer. There are no write, apply or revert controls.

The Changes view measures its own panel, independently of the chat workspace. Below 640 px it replaces the inline tree with the file drawer and renders unified diff, including after a panel resize. The path occupies a separate truncated row; its focusable tooltip exposes the full path without consuming code height.

## Trace a file change

1. A runner takes a bounded, ignore-aware snapshot of its current working directory before dispatching a turn. Git supplies file names only; HEAD and the index are never baselines.
2. Codex final native file-change patches must apply exactly to the captured contents. Contiguous changes in an ordered batch are composed before checking the final disk contents. Claude’s opt-in `file-capture-v1` SDK hooks capture Write/Edit before and after execution, verify their expected contents and preserve the originating request for subagents.
3. Deferred collection runs on the conversation’s ordered batch flush, outside the provider reader and the global SQLite writer. The writer commits evidence, operation deduplication, cumulative baseline/latest snapshots and a `conversation.resources_changed` event with the tool output transaction.
4. `ConversationResourcesService` owns the MobX model, capability checks, all pages and revision guards. It holds the existing conversation stream only while a resource consumer is active. Responses from a previous store generation cannot replace new state. The view renders server-generated cumulative patches with Pierre; it does not derive counts from tool logs or current disk contents.

The ledger keeps the first verified baseline and latest verified contents, not a sum of per-operation counts. A→B→C displays A→C, and returning to A removes the net change. Confirmed renames preserve identity. External edits, broken content chains and missing evidence suppress the current diff and counts. Previously trusted bytes remain internal and are never served as evidence for an uncertain record.

Shell, MCP and background writes are not attributed from exit status. Untracked tool activity marks coverage partial; an end-of-turn scan discovers changed paths when possible. Failed tools with no write add no file. Incomplete scans, historical imports and inherited Fork/Side history never become a confirmed zero. Persisted capture-start/end markers make an interrupted capture visible as incomplete after restart. Old transcript text is not backfilled.

## Contracts and storage

| Surface | Contract |
| --- | --- |
| Capability | `conversation-resources-v1`; older daemons keep the original workspace available |
| List | `GET /local/v2/sessions/{id}/resources?cursor=...`, 200 entries per page; cursor binds conversation and resource revision |
| Detail | `GET /local/v2/sessions/{id}/changes/{fileId}?revision=...`; stale revision returns 409, missing file or foreign conversation returns 404 |
| Scope | Existing V2 origin/user/workspace checks and selected device transport; no new file authorization or executable permissions |
| Side workspace | Additive `changes` and `attachment` tab variants; a client omits them when syncing an older daemon |
| SQLite | Migration 0008 adds resource state, file snapshots, operation keys and a resource/committed-attachment view; no PostgreSQL changes |

Attachments retain existing IDs and download routes. Source directories and file IDs are scoped by the owning conversation; inherited transcripts do not copy the parent ledger. Cwd is part of file identity. Detail reads come from SQLite, so deleted files remain inspectable.

The migration runs with the existing SQLite transactional migration mechanism. Back up the profile database before a manual rollback; there is no down migration. The current product has no conversation deletion operation; archive and closing a tab preserve records. The generated delete queries cover the three resource tables for the eventual transactional conversation deletion path. Deleting an entire isolated profile removes its resource database too.

## Bounds and recovery

- Text snapshot: 1 MiB and 20,000 newline characters per file; UTF-8 only, no NUL bytes. Binary or unavailable files expose metadata and a reason.
- Directory scan: 32 MiB, 10,000 entries, two-second deadline. Git-ignored files, build/dependency directories, credentials and symlink escapes are excluded.
- Persisted snapshots plus patch: 64 MiB per conversation, 1 GiB per profile. Quota failures preserve previous trusted bytes and mark the new state unavailable.
- Cumulative diff: common prefix/suffix are trimmed before Myers. The changed middle is limited to 4,000 lines and a one-million line-product; larger rewrites show the large-file reason. Pure additions/deletions remain linear.
- Claude pending native tools are bounded to 100. A broken evidence channel does not approve, retry or block a native tool. File I/O failures reduce coverage instead.
- Failed refresh keeps the last snapshot and offers retry. A stale detail never replaces another revision. There is no Git fallback, model resend or background reconstruction.

## Verify locally

Run the adjacent filechanges/store/service/localhost Go tests with `-race`; they use temporary SQLite/files and fake runners. Run the core resource-schema, conversation-client resource-service, Claude capture/host and tool-action tests. The Desktop Side/flow suites protect existing drafts, tab limits, previews and focus.

`e2e/conversation-resources.spec.ts` mounts production Desktop workspace/resource components with a fake transport. Serve `packages/tutti-agent-gui-host/vite.config.ts`, then point `PLAYWRIGHT_BASE_URL` at that server. It covers light/dark at 1440/1024/390, popover layout/focus, read-only diff, expanded split mode and the narrow file drawer. No user profile, real agent CLI, model API or PostgreSQL is used.

`e2e/conversation-resources-layout.spec.ts` covers long paths in both themes at all three widths, plus dragging the panel through the inline-tree threshold and restoring an expanded split diff. It asserts that the rendered code starts inside the scroll region and at least 200 px of that region intersects the visible panel and viewport; checking only document overflow misses vertically displaced code.

Dependencies are pinned in manifests/lockfiles. Pierre license/notice files and gotextdiff’s BSD license ship under Desktop renderer `public/licenses/conversation-resources/`. The Vite tool-action adapter adds the button to the pinned upstream GUI at build time and fails if the insertion anchor changes; vendored sources remain untouched.


The companion `e2e/conversation-resources-recovery.spec.ts` generates actual Codex/Claude fake-runner SQLite responses through the adjacent Go service tests before rendering them in the production Desktop components. It requires Go in addition to the fixture Vite server. It covers failed-add zero state, multi-file tree keyboard selection without transcript-history reads, full 20-tab retention and Changes reuse, read/refresh recovery, historical/unsupported/quota states, long paths, and distinct previews for same-name attachments and HTML/image outputs. This composes persisted runner evidence with UI rendering through a fake transport; it is not a real-agent or physical-device P2P test.
