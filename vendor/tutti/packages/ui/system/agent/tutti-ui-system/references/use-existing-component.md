# Use Existing Component

Use this reference when replacing local UI with `@tutti-os/ui-system` or when
answering what shared components exist.

## Workflow

1. Read component metadata first by `id`, `name`, `export`, `layer`, and
   `useCases`.
2. Prefer an existing component before creating, extracting, or promoting a new
   one.
3. Read the selected component source and props type before using it.
4. Import through stable public entrypoints only.
5. Replace only the visual surface.

## Caller-Owned Work

Keep these in the caller:

- host state and derived business state
- data loading, cache mutation, and persistence
- routing, daemon calls, Electron calls, and filesystem access
- i18n key lookup and user-visible product copy selection
- confirmation dialogs, queueing, install or uninstall flows, and navigation

The UI-system component should receive resolved props, labels, callbacks,
status values, icons, and children.

## Validation

Run the smallest relevant checks:

```bash
pnpm check:ui-boundaries
```

If the consumer code changed, also run the relevant consumer typecheck or build.
