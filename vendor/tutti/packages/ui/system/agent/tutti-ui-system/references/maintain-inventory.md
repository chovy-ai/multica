# Maintain Inventory

Use this reference when changing component ids, metadata, exports, or storyboard
inventory without promoting a new component.

## Metadata Rules

Every public UI-system entry must have metadata with:

- stable readable `id`
- globally unique kebab-case id
- `layer` as `base` or `business`
- `source` under `packages/ui/system/src`
- stable public `from` entrypoint

Do not expose `src/*` layout as public API and do not encourage per-file deep
imports.

## Storyboard Rules

Keep storyboard grouped by:

- `Foundation`
- `Base Components`
- `Business Components`

Visible component stories should support copying the component id.

When a base component is newly promoted into `@tutti-os/ui-system`, updating
inventory alone is not enough. The same change must also add or refresh a real
renderable example in `apps/ui-storyboard` so the promoted component is
immediately reviewable from the shared storyboard.

When changing metadata or storyboard inventory, keep ids stable unless the
rename is intentional and callers or docs are updated together.

## Validation

Run the relevant checks:

```bash
node tools/scripts/check-ui-metadata.mjs
pnpm check:ui-boundaries
pnpm --filter @tutti-os/ui-storyboard typecheck
```
