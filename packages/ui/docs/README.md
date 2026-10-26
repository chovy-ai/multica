# Web and Desktop UI rules

Entry point for changing Web or Desktop UI. It lists where each rule lives and
how to verify a change; it does not restate those rules. When a rule changes,
edit its source and keep this index pointing at it.

## Read before changing

Always read the Web/Desktop UI Rules, UI Copy, State Rules and Testing sections
of the repository [AGENTS.md](../../../AGENTS.md). Then read the sources for
what the change touches:

| Change touches | Source |
| --- | --- |
| Package placement, navigation, platform wiring | [AGENTS.md](../../../AGENTS.md) Sharing Rules and Package Boundaries |
| Font size, radius, color, control height, surfaces, motion | [tokens.css](../styles/tokens.css) and the comments beside each token |
| Button | [button.md](button.md) |
| Dialog or another modal surface | [dialog.md](dialog.md) |
| Other primitives | The component in [components/ui](../components/ui) and its existing call sites |
| Visible copy, translations, Chinese wording | [conventions.mdx](../../../apps/docs/content/docs/developers/conventions.mdx) and [conventions.zh.mdx](../../../apps/docs/content/docs/developers/conventions.zh.mdx) |
| Desktop window chrome, tabs, overlays | [AGENTS.md](../../../AGENTS.md) Desktop Rules |
| Mobile | [apps/mobile/AGENTS.md](../../../apps/mobile/AGENTS.md); the rest of this page does not apply |

Spacing, icon sizing and responsive breakpoints have no written rule. Follow
the nearest existing component in the same surface instead of introducing a new
convention.

## Verify

Run the narrowest check first, then the repository checks from the root:

```sh
pnpm typecheck
pnpm lint            # includes the views i18n guard
pnpm test
pnpm check:ui-radii
pnpm check:ui-exports
```

Add a regression test beside the implementation. Add or run a Playwright spec
in `e2e/` when the behavior depends on real layout, focus or scrolling.

Check the result visually:

- Primitives and tokens: [UI Lab](../../../apps/ui-lab/README.md)
  (`pnpm dev:ui-lab`), comparing original and edited previews in both themes.
- Product screens: run the change with the checkout's managed environment
  (`make up`) and inspect the affected Web or Desktop screen.

Capture before and after screenshots in light and dark themes, at a narrow
width when overflow is involved. Keep evidence under `.tmp/<topic>/` and do not
commit it. The `*-design-qa.md` files in
[docs/engineering](../../../docs/engineering) show the expected comparison
record.
