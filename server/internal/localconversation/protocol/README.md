# Local conversation protocols

Draft wire contracts for the Go-owned local conversation service. The plan is
in `docs/engineering/local-conversation-go-sqlite-plan.md`.

| Schema | Between | Plan section |
| --- | --- | --- |
| `schema/local-v2.schema.json` | daemon ↔ Desktop (HTTP / WS `/local/v2`) | §5, §7 |
| `schema/claude-adapter-v1.schema.json` | daemon ↔ per-conversation Claude adapter (stdio NDJSON) | §4.4 |

The schema files are the single definition source. Go and TypeScript types
will be generated from them once the generator is chosen; until then the
schemas are validated only by the golden samples.

## Golden samples

`testdata/<schema>/valid/<def>__<case>.json` must validate against
`$defs/<def>`, and `testdata/<schema>/invalid/<def>__<case>.json` must be
rejected. `go test ./internal/localconversation/protocol` checks both. Add a
sample with every schema change, including an invalid one when a constraint
is tightened.

## Event model summary

- Events are persisted with a per-conversation `seq`; `turn_seq` keeps the
  per-turn order the GUI uses.
- Output is grouped into items by `item_id`. `item.delta` appends text;
  `item.updated` replaces state without ending the item (background tasks);
  `item.completed` is the single final event with the complete item state.
- `user.message`, `turn.completed`, `item.completed` and
  `interaction.resolved` are final; everything else is not.
- The Claude adapter forwards raw SDK messages (`sdk_message`); the daemon
  normalizes them into these events.
