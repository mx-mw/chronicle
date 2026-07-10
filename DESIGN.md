# Chronicle design contract

## Project

- Name: Chronicle
- Path: `/Users/ethanwu/Developer/chronicle`
- Owners: Ethan Wu and Max Morrow
- Surface: Local-first knowledge operations tool
- Status: v2 hardening and workflow redesign
- Last updated: 2026-07-10

## Purpose

Chronicle captures meetings and sources, turns them into reviewable records, and
helps a small trusted team recall decisions with direct evidence.

The interface must make the boundary between captured material, model output,
human-approved memory, and retrieved evidence unmistakable.

## Audience

Primary users are Ethan and Max. They care about:

1. Knowing when recording is active and who has consented.
2. Reviewing extracted knowledge quickly without clerical overhead.
3. Trusting that recall can abstain and show where an answer came from.
4. Keeping the archive local, portable, and readable as Markdown.

## Primary feeling

A calm working archive. Editorial enough to feel considered, operational enough
to make state, risk, and next actions obvious.

## References

1. Typography and reading: Readwise Reader for long-form legibility and evidence.
2. Review workflow: Granola for meeting-note review with low interaction cost.
3. Knowledge structure: Obsidian for linked Markdown, backlinks, and portability.
4. Operational status: Linear for concise state language and fast keyboard flow.

These are behavioral references, not a request to imitate their visual systems.

## Content priority

First viewport:

1. Chronicle identity and compact readiness state.
2. Inbox count and the next record needing review.
3. One clear Ask or Find command surface.

Secondary:

1. Recent approved records.
2. Topics and maintenance suggestions.
3. Trust policy, system diagnostics, and weekly digest.

## Visual system

### Typography

- Display and reading: Iowan Old Style with Palatino and Georgia fallbacks.
- Interface: system sans stack.
- Technical metadata: system mono stack.
- Headings use balanced wrapping; short body text uses pretty wrapping.
- Dynamic counts and durations use tabular figures.

The serif is retained because Chronicle is explicitly an archive and reading
environment. Operational controls remain sans-serif.

### Color

- Background: warm paper, `#f3eee3`.
- Surface: pale paper, `#fbf8f1`.
- Ink: soft near-black, `#2a2620`.
- Muted text: darkened warm gray that passes WCAG AA at small sizes.
- Accent: restrained brick, `#8a3324`.
- Warning: ochre-brown; error: deep red; success: forest green.
- Dark mode stays in the same warm ink family.

### Layout

- Maximum width: 1240px.
- Desktop: compact top bar, command surface, then navigation rail and reader.
- Review views use a two-column evidence layout where space permits.
- Mobile: reader-first. Navigation lives in a drawer or compact picker and never
  pushes selected content below the full record list.
- Page gutters remain at least 16px on 390px screens.

### Shape

- Panels: 12px radius.
- Inputs and buttons: 8px radius.
- Small metadata markers: 4px radius, not pills by default.
- Depth uses warm layered shadows; dividers remain hairline borders.

### Motion

- `DESIGN_VARIANCE: 5`
- `MOTION_INTENSITY: 3`
- `VISUAL_DENSITY: 6`
- Motion communicates state changes only: drawers, selection, saving, approval.
- Interactive transitions are interruptible and limited to transform, opacity,
  color, and box-shadow.
- Buttons scale to `0.96` on press.
- Reduced-motion mode removes nonessential transitions.

## Components

- Navigation: Inbox, Capture, Records, Topics, Ask/Find, Digest, Trust.
- Command surface: one input with explicit Ask and Find modes.
- Review record: source context, warnings, editable extraction, evidence, actions.
- Status: plain state labels with one semantic indicator only where live state is
  real.
- Buttons: primary, secondary, text action, destructive confirmation.
- Forms: visible labels above controls, helper and error text below.
- Empty states: explain the first useful command and readiness blockers.
- Loading: shape-matched skeletons or concise status text with `aria-live`.
- Errors: state what failed, what was preserved, and the available recovery action.

## Interaction rules

- Captured content is never represented as approved memory.
- Destructive actions require explicit confirmation.
- Recall answers display validated evidence or an insufficient-evidence state.
- Search results open the selected record without losing the user on mobile.
- Every asynchronous action exposes pending, success, partial, and failure states.
- No placeholder-only form labels.
- Interactive hit areas are at least 40px.

## Anti-slop bans

- No generic purple or blue SaaS gradients.
- No decorative blobs, grids, glass, or glows.
- No three-equal-card dashboard as the primary structure.
- No over-rounded controls or decorative pills.
- No vague AI copy or invented metrics.
- No decorative status dots.
- No desktop layout that merely stacks the entire navigation above content.
- No raw model or provider URL in the primary header.
- No em-dash or en-dash characters in visible interface copy.

## Verification

- [x] Desktop screenshot at 1440x1000
- [x] Mobile screenshot at 390x900
- [x] Light and dark modes reviewed
- [x] No horizontal overflow
- [x] Selected record appears in the first mobile viewport after navigation
- [x] Text does not collide or clip
- [x] Links and buttons have hover, focus, and active states
- [x] Core text and controls meet WCAG AA contrast
- [x] Keyboard navigation and focus management work
- [x] Dynamic results are announced through live regions
- [x] Empty, loading, partial, error, and recovery states are present
- [x] Visible copy passes the anti-slop and dash checks
