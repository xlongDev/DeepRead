# DESIGN.md

Committed visual world for Deepread. Token source of truth: `packages/design-system/src/tokens.css` (+ TS mirror `tokens.ts`). Surface mode: **Operate** (product UI; earned familiarity, restrained color, consistency over surprise).

**Direction: Liquid Glass, after FlClash.** Three materials, and every surface picks one: a flat **page**, an opaque **card**, a translucent **glass** chrome. Depth comes from _which rung a thing sits on_, never from a shadow stack.

Reference implementation: `chen08209/FlClash` → `lib/ui/{liquid_glass,surface,shape,card}.dart`. The numbers below are its numbers, translated to CSS where CSS can hold them.

## Tokens

Five scales. A bare value in a component file is a bug, not a preference.

- **Type** — 8 steps: `--font-size-2xs`(11) `xs`(12) `sm`(13) `md`(15) `lg`(17) `xl`(20) `2xl`(24) `3xl`(30). Each ships a matching `--leading-*`; line-height is never a bare number. `--line-height-body` (1.6) and `--line-height-tight` (1.22) are the two semantic aliases.
- **Space** — `--space-N` where **N is the pixel value** (2 … 64). No xs/sm/md indirection to memorise. 4px base, 2px half-steps.
- **Radius** — one shape per rank, and the rank is what communicates what a thing is:
  `--radius-sm`(8) chip · `md`(10) control · `lg`(12) small card · `xl`(16) card · `2xl`(20) floating bar · `4xl`(28) sheet. Semantics: `--radius-control/group/card/bar/sheet`. `--radius-full` is for pills only (buttons, segmented thumb, nav indicator, avatars).
- **Elevation** — `--z-base` `raised` `panel` `chrome` `chrome-top` `overlay` `modal` `modal-top`. Only values that must outrank a _different_ module belong here; a number that only orders siblings inside one stacking context stays a local literal.
- **Motion** — `--spring-snappy` (controls, ≈350ms, ~4% overshoot) and `--spring-gentle` (structure, ≈560ms, barely overshoots). Both are sampled damped springs behind `linear()`, with a bezier fallback.
- **Icon** — not a CSS token (Phosphor takes `size` as a numeric prop). Exactly three: **14** inline/chip, **16** standard control, **20** prominent.

## Stylesheets

`apps/desktop/src/styles/global.css` is an **order manifest, not a style file**. It holds nothing but `@import` lines; the rules live in `styles/sections/` (12 files, 300–1300 lines each).

- **The import order _is_ the cascade.** `sections/` was cut at the existing section headers and nothing was moved. Do not "tidy" the order: several selectors win by source order alone (`.segmented-wrap > button` must stay after `.segmented button`, or its padding and radius get eaten). Section boundaries are contract, not decoration.
- **Append where you live.** A new rule goes into the section whose domain matches. A genuinely new domain gets a new file _and_ a new line in the manifest, in the position it must win from — never appended at the bottom for convenience.
- `12-a11y-stats.css` is last on purpose: the `prefers-reduced-motion` override must outrank every choreography it collapses.
- Splits are verified by build, not by eye: the bundled CSS must stay **byte-identical** to the pre-split bundle (`cmp` on `dist/assets/*.css`). A refactor that changes a byte of output has changed behaviour.
- **Nesting: adopt, don't migrate.** New rules may use native CSS nesting (Vite 8 inlines it, Chromium/WebKit both support it). The existing ~8k lines stay flat — a bulk rewrite is nine thousand lines of risk with zero visual payoff.
- **Same selector in two sections is allowed for exactly three reasons**, and the audit found seven instances, all of them these: the glass **thicker pour** (`background: --glass-bg` → `--glass-bg-bar` on panels holding running text), **z-index raise** (`--z-chrome` → `--z-panel` so a floating panel outranks the bars), and a **state recolour** that cannot join the shared block (`.reader-error`, whose group also carries `.reader-opening`). Anything else is a bug: rename or scope it.

## Surfaces

Three rungs, derived from the theme — never hand-picked per theme:

| rung | token            | what lives there                                            |
| ---- | ---------------- | ----------------------------------------------------------- |
| page | `--surface-page` | the desk. Never a component; only what components sit on    |
| card | `--surface-card` | anything you can point at: book, settings group, goal block |
| sunk | `--surface-sunk` | a hole **inside** a card: track, input, progress rail       |

**Page ≠ card is the whole hierarchy.** Light themes deliberately put ~6% luminance between them (page `#eeece7` / card `#ffffff`); flatten that and every card has to fake depth with a shadow, which is what makes an interface look muddy. Two tones and a radius does the same job for free.

- **Card = flat.** No shadow, no border. Radius `--radius-card`, background `--surface-card`. A card that needs a shadow is a card that is secretly a floating panel.
- **Physical objects keep one shadow.** Book covers are things, not surfaces: `0 1px 3px` at rest, `0 8px 24px -8px` on hover, and they lift 4px. One layer, never a three-layer stack.
- **Grouped lists**: label _outside_ the card, rows _inside_ it, hairline between rows. Label inside turns the card into "a box with a title"; label outside makes it "this set of things". `.settings-group`.
- **Inside the reader, the rungs are re-derived.** `--surface-page/card/sunk` come from the _app_ theme. A night-paper book read in a light app theme kept white cards while the panel's ink had already been remapped to light — white text on a white card, i.e. a settings panel full of invisible rows. The reader scope recomputes all three from paper + ink (94/6, 88/12), so a card is always one step off the paper in whichever direction that paper allows, and can never land on the text colour.

## Glass

Chrome only: floating toolbars, drawers, sheets, menus. Everything else is opaque on purpose — glass on everything is what makes an interface look like it is made of nothing.

The recipe (`--glass-bg`, `--glass-edge`, `--glass-blur`) has three ingredients, and dropping any one turns it into frosted plastic:

1. **A low tint** — 62% of the surface (78% for panels holding prose). You must be able to see the page move behind it.
2. **A saturated backdrop** — `blur(18px) saturate(1.9)`. Blur alone greys the backdrop; saturation is what makes it read as liquid.
3. **An edge** — 1px light rim on the top face, 1px ring just inside, 1px hairline outside, one landing shadow. FlClash draws this in a fragment shader; CSS gets it from three stacked shadows.

Panels that hold running text take the **page** tone, not the card tone (`--glass-bg-bar`). A white sheet with white groups inside is a flat white room.

## Toolbars

A toolbar is not an inventory of everything that exists; it is **the order a reader looks for things**.

- **Group by intent, not by widget type.** The reader top bar is 书内定位 (bookmark · search · TOC) / 阅读外观 (night · settings) / 阅读工具 (AI · TTS · more). Grouping reads as a handful of tools; twelve equal-weight icons in one pill read as a pile. Nothing about the icons changed — only the fact that one is reachable in one glance.
- **One entry per question.** 排版设置 and 显示设置 used to sit side by side as two buttons with two names, and no reader could tell which one held what — they answer the same question (_how should this reading surface look_), so they are one panel with two pages. Two buttons that both mean "settings" is a lookup cost with no payoff.
- **Divider height is a sentence, not a wall.** 2px inside a group, 8px between groups, and an 18px hairline centred vertically. A full-height rule inside a 44px pill reads as "partition"; the intent is only "a different kind of thing starts here".
- **Frequency decides what stays in the bar.** Five actions cover most sessions; the rest live behind `⋯` and keep their shortcuts as hints (`F11`). Frequency — not importance. Everything visible is not a virtue, it is a lookup cost paid on every glance.
- **`⋯` opens right-aligned past the viewport midline** (`useMenuPosition`, `align="auto"`). A menu that grows rightward out of the toolbar and then gets clamped back to the screen edge reads as "I clicked the wrong thing"; hugging the trigger's right edge is what makes it feel attached.
- Menus use `ActionMenu` (`role="menu"`; toggles are `menuitemcheckbox` so `aria-checked` is legal). `DropdownMenu` is the _pick a value_ sibling; both share one positioning hook so they cannot drift apart.
- **The bottom bar carries the position, so the track must carry it too.** A slider whose latest position is a 14px dot is decoration: the played portion is filled with `--color-accent`, the remainder stays at ink 14%, and the page readout sits right beside the track because it _is_ the slider's value. Word count and time-left are a second group, behind a hairline.
- **Two steps of ink, not three of size.** The page number is primary ink at 600; estimates are secondary at 400. Same 12px — shrinking secondary text to signal "less important" costs legibility and buys nothing.
- **A panel that scrolls scrolls one region.** The settings sheet pins its tab row and scrolls only the body; the reader settings panel does the same (`overflow: hidden` on the shell, `min-height: 0` on the pane). Letting the whole surface scroll takes the tabs (and the close affordance) away from the reader mid-scroll.
- **Scrolled content must be cut against something you drew.** A scroll container's padding scrolls with its content, so the 16px of air under the tab row exists only at `scrollTop: 0`. Half a scrolled-past card — theme swatches, half a segmented thumb — appearing in a transparent gap under the tabs reads as "an element escaped its container", not as "I have scrolled". Two parts, both required: a **marked** edge (the tab band's bottom hairline) so the cut belongs to the header, and a **fade as long as the padding** (32px top / 24px bottom here) so the sliced pixels dissolve instead of being knife-cut. The fade must not be longer than the padding it covers: past the end of the list, a still-fading last row says "there is more" when there is not.
- **One row, one height.** The shelf bar used to hold a 34px view toggle, a 37px sort trigger, a 41px 管理 and a 37px 导入 on the same baseline. A 3–4px difference between neighbours is not subtle — it reads as "these pieces were built apart". Set the height on `height` (`--shelf-control: 36px`), never reach it through padding: padding-based sizing drifts the moment the font metrics do. **And declare that token where every caller reads it** — while `--shelf-control` lived on `.shelf-tools`, the notes toolbar (same buttons, no such wrapper) resolved `height: var(--shelf-control)` to nothing, fell back to `auto`, and put 22.8px beside 20.8px. A variable scoped to a wrapper is a variable that silently vanishes for the next caller.
- **Dense toolbars label what is not self-evident.** The TTS row of 关 / 句级 / 词级 explains nothing on its own, while the engine row above it does (the buttons are named 系统语音, 云端语音). Label the first, leave the second alone; a label on every row is noise, a label on none is a puzzle.
- **Playing order is a schedule, not a stack.** In the TTS drawer a hairline separates _transport_ (lyrics, scrubber, play controls) from _adjustables_ (speed · voice · timer · engine · highlight). One rule at the right seam does more than six gaps ever will.

## Empty states

A panel's empty state is sized by the **area it reserves**, not by the state's importance. The TTS drawer hands its lyrics plate `flex: 1`; in standby that plate is the largest surface in the drawer, so it must say what the plate is for ("从本章开头朗读 / 按下方 ▶ 开始") — writing 待机 into it spends the biggest area on two characters.

- Panels that reserve area for content say what the content _is_, then the shortest path to making it appear.
- Copy must match what the input actually does. The search panel's idle line reads "按 Enter 搜索" because the field is uncontrolled and does not search as you type; "输入关键词" alone implies a search already ran and returned nothing.
- Hover states belong to `:hover` only; an "always-on" chip must be visible on its own (see quiet chrome).

## Selection

Two kinds, because two different questions are being answered.

- **Navigation** (sidebar row) = _where am I_. Neutral row fill (`ink 7%`) that slides between rows + a 3×16 accent bar 6px outside the bar's left edge. The bar marks the row; the fill says it is live. Text stays ink; only the icon goes accent. The bar's offset is measured **from the sliding indicator**, so it must be recomputed whenever the nav's own padding changes — a leftover `calc(var(--space-16) * -1)` from when the nav had no padding parks the bar at the window edge, 16px from the row it belongs to, where it reads as a rendering artefact rather than an indicator.
- **A switch** (segmented control, settings tab) = _which value is on_. Solid `--color-accent` pill, `--color-on-accent` label, sliding thumb under `--spring-snappy`. A switch has exactly two states and should look like it.
- **Never** `--color-accent-soft` + accent text for either — it is neither a location nor a state, just a wash.
- **Decoration does not get to compete with the selection signal.** Every theme swatch carried an accent dot; the accents are nearly all the same blue, so the dots carried no information and twelve identical marks next to a 2px border read as "all twelve are selected". If a mark appears on every item, it is not a mark — delete it.
- **A switch fills its row; it does not grow with its labels.** `max-width: 100%` caps the pill's box but nothing inside it, so a 4-option segmented next to a 4-character label kept its content width (191px), walked 15px past the card's content edge, and had its last option sliced by the panel's `overflow`. A segmented control's width is not "however wide the words happen to be" — it is the width left in the row, divided **equally** among the options (`flex: 1 1 0`). Equal division also means the label of `宽` and `特宽` no longer makes two neighbours 13px apart. Where nothing overflows (a one-option `选择 .ifo`), it keeps its intrinsic width instead of stretching into a full-width button.
- **A pill is not a text row.** `.settings-group > * + *` draws the in-group hairline as `border-top` + `padding-top: 12px`; on a segmented control that lands _inside_ the capsule, leaving 12px of empty track above the buttons and pushing the thumb to the bottom edge. Divider spacing belongs to rows of text, not to anything that is already a surface.
- **Uneven labels want a grid, not a wrapped row.** The eight font options ran from 2 to 4 characters, so `flex-wrap` broke them into three ragged lines whose widths had nothing to do with each other — eight chips that looked scattered rather than chosen from. Three equal columns (`repeat(3, minmax(0, 1fr))`) plus a CSS ellipsis for over-long custom font names costs the same space and reads as a table of choices: cells line up, rows line up, and a long name only affects its own cell.
- **Nest the radii.** Inside a 10px track with 2px padding the cells are 8px, not `--radius-full`: a capsule inside a rounded rectangle leaves slivers of track in all four corners, and the selected cell then looks pasted on rather than seated in.
- Dark themes with a lifted accent (`#6e93f6` and friends) set `--color-on-accent` to ink, not white: white on that blue is 2.4:1.

## Type

- UI: system sans stack (`--font-sans`), weights 400/500/600 only (600 for data values).
- **A section label is quiet, not invisible.** Sidebar 我的分组 / 标签 sat at 11px in tertiary ink — 2.6:1 on paper, which you read by guessing — while the same role in a modal (`.modal-section-label`) was 12px in secondary ink. Reticence is expressed by size, tracking and weight; past that, hold the ink at secondary. Two treatments of one role is the most visible kind of untidiness, because they sit in the same screenful.
- Serif (`--font-serif`) is for book-like moments only: cover monograms, the empty-state title, library brand.
- Reading content: the book's own CSS wins (foliate-js renders original typography); user font-size control scales via renderer styles, never re-typesets text.

## Motion

Three layers, each with one job: **structural** (view switch, panel enter — `--spring-gentle`), **feedback** (press/hover — `--spring-snappy`), **state** (list entrance, chart growth). If a motion can't say which layer it's in, it doesn't ship.

Press is `scale(0.97)`, always. Centred elements move with `translate`/`scale`, never `transform` — a global `button:active{transform:scale(.97)}` outranks a component's own `:active` on specificity.

Every duration and easing is a token. The only exceptions are the page-turn View Transition choreography numbers (fixed ms — they are staging, not UI tempo).

`prefers-reduced-motion` is handled by **one global override** at the end of `sections/12-a11y-stats.css` (the last section, so it outranks everything it collapses), not a selector allowlist.

## Rules

- The reading canvas is plain and quiet; all decoration lives in chrome.
- Icons: Phosphor (`@phosphor-icons/react`), one family, default weight; no emoji, no hand-drawn SVG. Three sizes only.
- Every control ships with hover/focus-visible/active/disabled states; loading uses skeletons, empty states teach.
- **A filled button is not disabled by opacity.** 45% of a solid accent is a _lighter blue button_ — still looks pressable — and its white label drops under 3:1, so it reads as broken rather than unavailable. Filled buttons swap to a neutral fill + tertiary ink and drop the shadow; the colour itself is the "you can't press this" signal.
- **Zero is not a minimum.** The 7-day chart floored every bar at 3px so a blank day stayed visible, which drew "read nothing" exactly like "read two minutes" — the chart stated a falsehood to stay legible. `is-zero` removes the floor: an empty day is an empty track.
- **No data is not a chart.** After the floor was removed, a week with no reading still rendered seven full-height tracks — identical white boxes that read as a skeleton that never finished loading. The track is a scale, and a scale carries no information without a reading on it: when the whole window is zero, draw the sentence instead of the chart. The metric footnote goes with it (two grey lines saying "nothing yet" is one line too many); a chart that has data keeps both.
- **One class, one intent.** `.note-action` was a text link in the notes list and a padded button in the selection toolbar; the later block won every shared property, so each caller got half of the other's recipe. `.settings-group` was a card in the sheet and a bare wrapper in the reader panel; its `gap: 8px` silently retuned the sheet. Two intentions need two names — a renamed class or a scope (`.reader-settings .settings-group`) — never a second definition of the same selector.
- Toolbars auto-hide while reading; appear on pointer movement, tap, or keyboard.
- Browser surfaces (selection color, focus rings, scrollbars) themed from tokens.
- **Comments explain why, and they must stay true.** A stale comment is worse than none — when a rule changes, the paragraph above it changes in the same edit.
