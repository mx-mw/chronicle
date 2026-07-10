# Chronicle design contract

## Project

- Name: Chronicle
- Path: `/Users/ethanwu/Developer/chronicle`
- Owners: Ethan Wu and Max Morrow
- Surface: Local-first knowledge operations tool
- Status: task-first organic workspace redesign
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

A living memory workspace. It should feel calm, tactile, and immediately
understandable: Chronicle brings the next meaningful action forward, then lets
approved knowledge unfold naturally as the user explores it.

## References

1. Apple Watch: glanceable modules, purposeful depth, compact state changes, and
   controls that feel physical without becoming ornamental.
2. Pinterest: content-first discovery, asymmetric rhythm, and collections that
   feel browsable rather than database-like.
3. Readwise Reader: long-form legibility and fast retrieval.
4. Granola: low-friction meeting-note review and evidence inspection.

These are behavioral references, not a request to imitate their visual systems.

## Content priority

First viewport:

1. The next draft requiring a decision, when one exists.
2. Recent approved memory and unfinished actions when review is clear.
3. Direct actions to add a source or search memory.

Secondary:

1. Library discovery across records and topics.
2. Evidence, raw sources, and advanced extraction fields on demand.
3. Trust policy and diagnostics inside Settings.

## Visual system

### Typography

- Interface and display: the native Apple system family, with Avenir Next as a
  characterful fallback on macOS.
- Long approved records: Charter and Georgia fallbacks, used only for reading.
- Technical metadata: the native system mono family.
- Headings use balanced wrapping; short body text uses pretty wrapping.
- Dynamic counts and durations use tabular figures.

### Color

- Background: cool mineral mist, `#f2f2ef`.
- Surface: soft white, `#fbfbf9`.
- Ink: graphite, `#20201e`.
- Muted text: mineral gray that passes WCAG AA at small sizes.
- Accent: deep carmine, `#a62d2d`, shared by actions and active states.
- Warning, error, and success remain semantic and appear only where state is real.
- Dark mode uses neutral charcoal surfaces rather than brown-on-brown ink.

### Layout

- Maximum width: 1440px.
- Desktop: slim navigation rail, content workspace, and optional evidence rail.
- Home uses an asymmetric grid of real work: next review, recent records, open
  actions, and library state. Tile size follows information importance.
- Library starts as a masonry-like board and becomes list plus reader after a
  record is selected.
- Search is an on-demand overlay, never a permanent band above every task.
- Mobile uses a compact bottom navigation and full-screen task transitions.
- Page gutters remain at least 16px on 390px screens.

### Shape

- Primary modules: 24px radius.
- Nested surfaces: 16px radius with concentric spacing.
- Inputs and buttons: 12px radius; compact segmented controls may use pills.
- Depth uses layered mineral shadows; dividers remain hairline rules.

### Motion

- `DESIGN_VARIANCE: 7`
- `MOTION_INTENSITY: 4`
- `VISUAL_DENSITY: 6`
- Motion communicates state changes only: search reveal, selection, saving,
  evidence disclosure, and approval.
- Interactive transitions are interruptible and limited to transform, opacity,
  color, and box-shadow.
- Buttons scale to `0.96` on press.
- Reduced-motion mode removes nonessential transitions.

## Components

- Navigation: Home, Review, Library, and Settings.
- Global actions: Add source and Search memory.
- Search surface: one overlay with answer and exact-match modes.
- Review record: readable extraction first, editing and advanced fields on demand.
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
- Review opens on the next draft on desktop and as a focused queue-to-detail flow
  on mobile.
- Evidence remains available beside the draft but never competes with the primary
  approve decision.
- Every asynchronous action exposes pending, success, partial, and failure states.
- No placeholder-only form labels.
- Interactive hit areas are at least 40px.

## Anti-slop bans

- No generic purple or blue SaaS gradients.
- No decorative blobs, grids, glass, or glows.
- No three-equal-card dashboard as the primary structure.
- No roundness without hierarchy: large modules, smaller nested surfaces, and
  compact controls follow a documented concentric scale.
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
