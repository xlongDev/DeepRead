# DESIGN.md

Committed visual world for AI Reader. Token source of truth: `packages/design-system/src/tokens.css` (+ TS mirror `tokens.ts`). Surface mode: **Operate** (product UI; earned familiarity, restrained color, consistency over surprise).

## Tokens

- Light theme: warm paper reading surface (`--color-bg #f6f5f2`, off-black text) plus neutral panels; dark theme: near-black warm gray surfaces, no pure black.
- Accent: one muted indigo-blue (`--color-accent`) used only for primary actions, current selection, and focus states.
- Radius system: interactive = pill (`--radius-full`), containers = `--radius-xl`, inner chips = `--radius-md`. Applied uniformly.
- Shadows: soft, tinted to the warm hue, low alpha; glass panels (toolbars/panels only, never reading content) use `backdrop-filter` with a solid-surface fallback under `prefers-reduced-transparency`.
- Motion comes in three layers, each with one job: **structural** (view switch, panel enter — 150-400 ms via `--duration-*`), **feedback** (press/hover — `--duration-fast`), **state** (list entrance, chart growth — `--duration-slow`). If a motion can't say which layer it's in, it doesn't ship.
- Every duration and easing comes from a token. The only exceptions are the page-turn View Transition choreography numbers (fixed ms, they are staging, not UI tempo).
- `prefers-reduced-motion` is handled by **one global override** at the end of `global.css`, not a selector allowlist — an allowlist gets forgotten the next time someone adds an animated control.

## Type

- UI: system sans stack (`--font-sans`), fixed rem-ish px scale from tokens (13/15/21), weight 400/500 only.
- Reading content: the book's own CSS wins (foliate-js renders original typography); user font-size control scales via renderer styles, never re-typesets text.

## Rules

- The reading canvas is plain and quiet; all decoration lives in chrome (toolbars, panels).
- Icons: Phosphor (`@phosphor-icons/react`), one family, default weight; no emoji, no hand-drawn SVG.
- Every control ships with hover/focus-visible/active/disabled states; loading uses skeletons, empty states teach.
- Toolbars auto-hide while reading; appear on pointer movement, tap, or keyboard.
- Browser surfaces (selection color, focus rings, scrollbars) themed from tokens.
