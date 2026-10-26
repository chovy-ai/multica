# Promote Business Component

Use this reference when business-side UI should become a reusable
host-agnostic display component.

## Business Criteria

Proceed only if the component can render from props with no host side effects.
Business components may expose domain display props such as workspace, file,
task, agent, run, project, account, status, permission, labels, and callbacks.

Do not promote UI that owns daemon, Electron, router, store, query, persistence,
polling, filesystem access, or workflow orchestration.

## Agent-Owned Analysis

The agent must automatically analyze the candidate from code evidence. Do not
ask the user to provide the state matrix or props boundary unless the code has
conflicting evidence or an unclear business meaning.

Scan:

- source component and nearby helpers
- dependent presentational subcomponents imported by the source component
- third-party-library wrappers used by the candidate UI, such as Radix,
  floating UI, resizable panels, drag/drop, virtualization, or editor shells
- call sites and conditional rendering branches
- props, types, tests, mocks, fixtures, and sample data
- relevant i18n keys and resolved labels
- existing UI-system metadata and components

Build a state matrix from that evidence. For each candidate state, record:

- state name
- source file or branch proving the state
- props or data needed to render it
- variation axes and whether each axis is visual, structural, behavioral, or
  host-owned
- host-owned behavior that must stay outside the shared component
- whether the state belongs in the shared component contract

## Agent-Owned Boundary Decision

The agent decides the proposed component boundary before implementation:

- component `id` and `layer: "business"`
- source usage being replaced
- intended reuse surfaces
- public props and callbacks
- API shape decision: variants, discriminated unions, slots, children, explicit
  component variants, compound subcomponents, provider state, and host-owned
  caller logic
- host-owned state and side effects that remain outside
- states that will appear in storyboard
- stable export path and metadata entry

If the candidate is not reusable or cannot stay host-agnostic, do not promote
it. Prefer using existing components or keeping the UI local.

## API Composition Gate

Before writing the promoted component, convert the state matrix into a public
API deliberately:

1. List every visual, structural, and behavioral variation found in source
   evidence.
2. Keep only standard state booleans such as `disabled`, `loading`, `selected`,
   `open`, `required`, or `invalid` when they represent real states and do not
   create impossible combinations.
3. Replace mode booleans such as `isFoo`, `showBar`, and `withBaz` with a
   finite variant, discriminated union, explicit component variant, slot, or
   composed child.
4. Prefer `children` or named slots for caller-owned visual regions. Use render
   props only when the shared component needs to pass data back to the caller.
5. Use compound components and context only when consumers need to assemble
   subparts while sharing state. A simple row, card, badge, toolbar, or display
   panel should stay as a direct props-driven component.
6. If shared state is necessary, define a narrow injectable context contract as
   `state`, `actions`, and `meta`. Providers may adapt caller state, but daemon,
   Electron, router, store, query, persistence, filesystem, i18n lookup, and
   workflow orchestration remain outside `@tutti-os/ui-system`.
7. For new React components, use the repository's React 19 baseline, including
   `ref` as a prop when needed. Do not rewrite shadcn or Radix-acquired
   internals solely to normalize API style.

Stop promotion if the only way to represent the source states is a broad bag of
unrelated boolean props or leaked host state. Narrow the boundary, create
explicit variants, or keep the UI local.

## Implementation Blueprint

Use a copy-first promotion workflow. The first implementation should be a
props-driven copy of the source business UI, not a new abstraction designed from
memory. Preserve the source DOM hierarchy, visual structure, spacing, state
branches, slots, and interaction affordances until parity is visible in
storyboard. Only after parity exists should the API be tightened and generalized.

Run promotion as a loop: migrate, review, migrate, review. The first migration
must make source-backed parity visible; review then measures drift against the
original code and screenshot; the next migration closes those findings without
redesigning. Continue until no material DOM, visual, token, state, icon, or
storyboard coverage drift remains. Do not treat the first extracted abstraction
as done if review still reports medium or high difference.

The promoted UI must follow the original design. Do not introduce new visual
ideas while promoting: no extra decoration, layout chrome, icons, controls,
copy, motion, spacing, state branches, or hierarchy that cannot be traced to the
source UI or the user's screenshot. Token replacement and primitive composition
are allowed only when they preserve the observed design and interaction path.

Icons are part of that source-derived visual contract and must still enter the
shared package through the UI-system icon layer. When the source UI uses an
icon, first reuse an existing `@tutti-os/ui-system/icons` export. If no
matching icon exists, promote the source-derived SVG or mark into
`packages/ui/system/src/icons`, add metadata, and consume that exported icon
from the business component or storyboard. Do not leave inline SVG/data URI
icons, app-local asset imports, or direct third-party icon imports in promoted
components or storyboard examples.

Copy and classify dependent subcomponents during the same migration. If a
nested helper is pure display, move it with the business component and convert
host data to props. If it wraps a third-party UI behavior that is reusable
outside the business domain, promote or reuse it as a `base` primitive first and
compose it from the business component. If it owns host state, i18n lookup,
daemon calls, router/filesystem access, persistence, or workflow orchestration,
leave that behavior in the caller and replace the nested region with data,
labels, callbacks, or slots. Do not rewrite a new nested component from memory
while the original source behavior still exists to copy.

Implement the promoted component directly from three inputs:

- the code-evidence state matrix
- the proposed public props and callback boundary
- the existing candidate source UI or visual surface being extracted

The promoted component should start as a props-driven version of the candidate
source with host-owned behavior removed. Preserve the real visual structure,
component composition, class names, spacing, icons, and state-specific branches
unless they depend on host-owned behavior. Replace host-owned behavior with
public props, callbacks, caller-owned slots, or explicit variants. Add
storyboard examples for every accepted public state in the same change so the
review can inspect the finished implementation instead of a preflight draft.
Do not add states, controls, copy, icons, animation, or visual wrappers that the
source component did not have unless the user explicitly asks for that design
change.

Generalize in this order:

1. Copy the existing component structure and nearby presentational helpers.
2. Trace dependent subcomponents and third-party wrappers; move pure display
   helpers with the component, promote reusable third-party wrappers to `base`
   primitives, and mark host-coupled children as caller-owned slots or data.
3. Replace host imports, data derivation, i18n lookup, store reads, side effects,
   and daemon/router/filesystem calls with props, labels, callbacks, or slots.
4. Recreate the original visual states in storyboard before simplifying the API.
5. Run independent review against the source UI and close material drift before
   simplifying the API.
6. Standardize the API names and types around data, labels, actions, variants,
   and slots while preserving visual and behavioral parity.
7. Replace app-local styling with UI-system tokens and base primitives only when
   the replacement does not change the observed UI or interaction path.
8. Reject or remove any invented UI added during promotion unless it is backed
   by source evidence or an explicit user-approved visual change.

Do not skip directly to a polished abstraction. If the first promoted version
cannot be compared against the source screenshot or source state, the promotion
is incomplete.

If the draft still needs app state, navigation, fetching, persistence, i18n key
lookup, or host adapters to render, stop and revise the component boundary
instead of promoting it.

## Promotion Chain Demo

Example request:

```text
Promote the managed agent settings table into @tutti-os/ui-system.
```

Expected chain:

1. **Analyze source evidence**
   - Read the source table, settings panel call sites, tests, mocks, and i18n
     labels.
   - Check existing metadata for reusable table, badge, button, dialog, and
     icon primitives.
2. **Build the state matrix**

   ```text
   normal
   - Evidence: settings table renders installed agents with status and actions.
   - Props/data: rows, status labels, action labels, icon slots, callbacks.
   - Host-owned: install/uninstall orchestration, queue state derivation, i18n.
   - Contract: yes.

   empty
   - Evidence: settings surface renders no configured agents.
   - Props/data: empty title/body.
   - Host-owned: deciding whether inventory is empty.
   - Contract: yes.

   disabled
   - Evidence: actions disabled while an operation is pending.
   - Props/data: disabled rows or disabled actions.
   - Host-owned: permission and pending-operation calculation.
   - Contract: yes.

   error-like
   - Evidence: row can show install failure or unavailable status.
   - Props/data: tone, status label, supporting text.
   - Host-owned: failure classification and retry behavior.
   - Contract: yes.
   ```

3. **Decide the boundary before implementation**
   - `id`: a stable kebab-case business component id, for example
     `example-business-component`
   - `layer`: `business`
   - Export: a matching PascalCase component name, for example
     `ExampleBusinessComponent`
   - Public props: rows, labels, icon render slots, action callbacks, disabled
     flags, status/tone fields, empty-state copy.
   - API shape: row status as finite tone values, callbacks as host-provided
     actions, empty state copy as labels, and no install/uninstall mode
     booleans. If the table later needs caller-owned row adornments, prefer a
     named slot or composed child over a broad render prop.
   - Host-owned behavior: i18n lookup, daemon calls, install queue,
     confirmation dialogs, persistence, routing, and state derivation.
4. **Implement the promoted component with copy-first parity**
   - Copy the current candidate source into the final
     `packages/ui/system/src/components/<component-dir>/index.tsx` component.
   - Copy dependent presentational helpers and classify any third-party
     wrappers before changing behavior. Reuse or promote base primitives for
     reusable library wrappers instead of rebuilding them in the business file.
   - Route icons through `@tutti-os/ui-system/icons`: reuse existing exports or
     promote source-derived icons into the package icon layer with metadata
     before using them in the component or storyboard.
   - Keep the real table layout, status cells, action affordances, icon
     placement, empty state, nested display helpers, and disabled/error branches.
   - Replace host behavior with props, labels, callbacks, and caller-owned
     slots: i18n lookup, queue state, confirmation dialog decisions, daemon
     calls, and install orchestration stay outside the component.
   - Only after storyboard parity is visible, simplify the copied API toward
     durable `items`, `labels`, `actions`, explicit variants, and slots.
   - Make only package integration edits: final exported prop types, imports,
     class cleanup, and package-local helpers.
   - Export it from stable barrels.
   - Add metadata with `layer: "business"` and storyboard coverage for the
     accepted states.
   - Replace the original app UI with `@tutti-os/ui-system` imports while
     leaving host-owned behavior in the caller.
5. **Validate and report**
   - Review the finished implementation through the storyboard states and the
     migrated consumer surface.
   - Start an independent design-foundation review subagent. Give it the
     promoted files, original source usage, selected state matrix, storyboard
     entry, metadata entry, and `ui-system.md`.
   - Include the API shape review in the handoff: accepted booleans, variants,
     slots or children, explicit variants, provider state if any, and
     host-owned behavior kept in the caller.
   - Resolve any subagent-reported design drift before reporting completion.
   - Run the promotion review gate: Frictionless task path and action hierarchy,
     Quality Craft visual parity and token/state coverage, and Trustworthy
     labels, recovery, policy, and provenance behavior.
   - Run metadata, boundary, storyboard, and relevant package checks.
   - Report the state matrix summary, final boundary, promotion review result,
     subagent design-foundation result, validation results, and uncovered
     risks.

## Implementation

1. Copy the existing business component structure into `packages/ui/system`
   before abstracting it.
2. Keep all host-owned behavior in the caller by replacing it with props,
   labels, callbacks, or caller-owned slots.
3. Preserve the source visual and interaction shape until storyboard parity is
   visible.
4. Standardize the API incrementally. Do not add new mode booleans or
   host-owned state while moving the candidate UI into the shared package.
5. Add stable exports and metadata with `layer: "business"`.
6. Add storyboard examples for normal, empty, disabled, loading, and error-like
   states when those states exist in the public contract.
7. Migrate callers by replacing only the visual surface.
8. Run the promotion review gate from
   `ui-system.md` against the promoted component
   and migrated consumer.
9. Start the design-foundation review subagent and resolve any reported drift.

## Validation

Run the relevant checks:

```bash
node tools/scripts/check-ui-metadata.mjs
pnpm check:ui-boundaries
pnpm --filter @tutti-os/ui-storyboard typecheck
pnpm --filter @tutti-os/ui-system typecheck
```

If a consumer was migrated, also run that consumer's typecheck or build.

Report:

- state matrix summary
- component boundary decision
- API composition decision and any rejected boolean or state combinations
- promotion review result with Frictionless / Quality Craft / Trustworthy
  pillar status and blocking/major/minor issues
- design-foundation subagent result
- validation commands and results
- remaining risks or uncovered states

Do not report full design-foundation compliance unless the subagent review ran
and found no unresolved drift. If subagents are unavailable, report the
verification as blocked.
