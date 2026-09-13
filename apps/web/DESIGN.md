---
name: KaiERP
description: Fluent, Apple-esque, minimalist ERP UI — depth and vibrancy carry hierarchy instead of border weight.
colors:
  ink-page: "#F2F2F4"
  ink-surface: "#ffffff"
  ink-hairline: "#e7e7eb"
  ink-border: "#d7d7dd"
  ink-border-emphatic: "#a9a9b4"
  ink-muted: "#6b6b74"
  ink-secondary: "#57575f"
  ink-body: "#3A3A45"
  ink-primary: "#0F0F12"
  accent-soft: "#8a6a00"
  gold: "#FFC20E"
  gold-soft: "#FFF3CE"
  band-strong: "#1a7a4c"
  band-stable: "#3d8f68"
  band-watch: "#b5570c"
  band-strained: "#a8481a"
  band-critical: "#ad2c22"
  div-software: "#2a78d6"
  div-skill: "#c2670f"
  div-education: "#12805c"
  div-shared: "#8f3d90"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontWeight: 700
    letterSpacing: "-0.01em"
  body:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    letterSpacing: "0.08em"
  numeral:
    fontFamily: "Archivo, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontFeature: "tabular-nums"
rounded:
  sm: "14px"
  md: "18px"
  lg: "22px"
  xl: "30px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "20px"
components:
  button-primary:
    backgroundColor: "{colors.ink-primary}"
    textColor: "{colors.ink-page}"
    rounded: "9999px"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.ink-primary}"
  card:
    backgroundColor: "{colors.ink-surface}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input:
    backgroundColor: "{colors.ink-surface}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
---

# Design System: KaiERP

## Overview

**Creative North Star: "The Vibrant Ledger"**

KaiERP replaced a deliberately flat, border-only-hierarchy system (three border weights — 1px/2px/3px — carrying everything a shadow would normally carry) with a fluent, Apple-esque, minimalist depth language, taken as the canon/standing-exit path rather than an invented world: Apple's own system apps and macOS vibrancy (Settings, Mail, Notes, Big Sur/Sonoma-era translucency) fused with Notion/Craft's calm, content-first card minimalism. The paper ground, ink text scale, and the three-division/status categorical palettes are unchanged from the incumbent system — they encode real data, not aesthetics — so the shift is structural, not a repaint: hierarchy now comes from a resting/raised/floating elevation ladder of real, soft, dual-layer shadows, and glass (translucency + backdrop-blur) is reserved for chrome that genuinely floats over content, never sprinkled as decoration on a static panel.

This is explicitly a dense, data-heavy Operate-mode product — tables of money, statuses, approvals — and the depth language was confirmed to apply uniformly, including the densest screens (KPI walls, ledger and invoice tables), not just the chrome. Tabular numerals stay crisp inside it: `.num`/`.tabular`/`.kpi-value` keep `font-variant-numeric: tabular-nums` and a 112% font-stretch on Archivo regardless of the surface they sit in.

**Key Characteristics:**
- Elevation (shadow), not border weight, carries hierarchy.
- Glass/vibrancy is functional (a floating surface with real content behind it), never decorative.
- Headings are sentence-case, size+weight — small-caps tracked labels are reserved for the grouped-list convention (section/kpi/sidebar labels), not headings.
- The three-division and five-status colors are categorical data encodings and are never restyled for aesthetic reasons.
- One consistent-stroke icon system (lucide-react) — no Unicode dingbats standing in for icons.

## Colors

Paper and ink carry the page; gold is the one accent, spent almost nowhere except as a hover state and the sidebar's active pill.

### Primary
- **Ink** (`#0F0F12`): primary text, and — inverted — the fill for primary buttons and the sidebar. Ink is the "default action" color; gold is what it turns under the cursor.

### Secondary
- **Gold** (`#FFC20E`): the single accent. Used as: the hover fill for primary/gold buttons, the sidebar's active-nav-item pill, the sidebar brand mark, and a soft outer glow (`shadow-[0_2px_10px_rgba(255,194,14,0.25)]`) on both. **The One Accent Rule.** Gold never carries body text — it fails contrast on paper — so a readable gold is always `accent-soft` (`#8a6a00`), never the raw hex.

### Neutral (the `ink` scale)
- **Page** (`#F2F2F4`): the canvas itself.
- **Surface** (`#ffffff`): a card, KPI tile, input, or any element raised off the page.
- **Hairline** (`#e7e7eb`): the softest structural line — row dividers inside a table, a card's own 1px edge. A whisper, not a rule.
- **Border** (`#d7d7dd`): a slightly firmer line — table header rules, input borders at rest.
- **Border, emphatic** (`#a9a9b4`): scrollbar thumb, focus-adjacent borders.
- **Muted / secondary / body / primary text** (`#6b6b74` / `#57575f` / `#3A3A45` / `#0F0F12`): the text scale, unchanged from the incumbent system.

### Data colors (functional, not aesthetic — never restyled for a redesign)
- **Status band** (`strong` #1a7a4c, `stable` #3d8f68, `watch` #b5570c, `strained` #a8481a, `critical` #ad2c22): the only semantic-severity colors. Used for chips, KPI status icons, and health-score verdicts.
- **Division** (`software` #2a78d6, `skill` #c2670f, `education` #12805c, `shared` #8f3d90): fixed order, never cycled — the same hue for a division wherever it appears (a table dot and a chart bar must agree). Validated for contrast and (mostly) CVD-safety; the one residual warning (green↔orange under protanopia) is mitigated with a legend and direct labels, never color alone.

### Named Rules
**The Functional Color Floor.** Band and division colors are data encodings, set once and validated for contrast/CVD-safety. No visual-world change may retint, lighten, darken, or reassign them — a redesign changes how hierarchy and depth read, never what a color means.

## Typography

**Display Font:** Archivo (with ui-sans-serif, system-ui fallback)
**Body Font:** IBM Plex Sans (with ui-sans-serif, system-ui, -apple-system, Segoe UI fallback)
**Numeral Font:** Archivo, set at 112% font-stretch with tabular numerals — money and counts are never proportional.

**Character:** Archivo's wide, geometric weight carries every heading and every number, so a column of rupee figures reads as one block rather than a list of different-width strings; IBM Plex Sans carries body copy at a calmer, more neutral register underneath it.

### Hierarchy
- **Display / Headline** (`h1`/`h2`/`h3`: font-bold, tracking-tight, sentence case): page and section titles. No longer uppercase or extrabold — Apple/Notion carry hierarchy with size and weight, not a caps-lock block.
- **Title** (`.card-title`: 14px, font-semibold): a card or panel's own heading, sentence case.
- **Body** (14px base, `line-height: 1.5`, IBM Plex Sans): running copy.
- **Label** (`.label`, `.kpi-label`, `.section-title`, `.sidebar-group`: 10–12px, font-semibold/bold, uppercase, tracked 0.08–0.12em): the one place uppercase tracking survives — the grouped-list convention Apple's own Settings app uses for section headers, not a page or card title.
- **Numeral** (`.kpi-value`: 25px, font-black, tabular-nums, 112% font-stretch): a KPI's headline figure.

### Named Rules
**The Sentence-Case Heading Rule.** `h1`/`h2`/`h3` and `.card-title` are never uppercase. Uppercase tracking is reserved for `.label`/`.kpi-label`/`.section-title`/`.sidebar-group` — small, secondary, grouped-list-style text — never a page or card's own title.

## Layout

Density is unchanged from the incumbent system: a 14px base font, tight-but-legible table rows (`px-2.5 py-2.5`), and a persistent 224px (`w-56`) sidebar on desktop. The one structural addition is responsive: below the `md` breakpoint the sidebar collapses entirely (`hidden md:flex`) and reopens as a hamburger-triggered overlay drawer (`fixed inset-0 z-40`, closing on navigation or a scrim tap) rather than squeezing a fixed-width rail into a narrow viewport.

## Elevation & Depth

Real, soft, dual-layer shadows — the system's defining change from its predecessor, which was flat by explicit decision. Every shadow token pairs a tight, low-opacity layer (crispness at the edge) with a broader, softer layer (the actual lift), always neutral-dark (`rgba(15,15,18,…)`), never tinted to a UI color.

### Shadow Vocabulary
- **Soft** (`0 1px 2px 0 rgba(15,15,18,0.05)`): resting state — an input, a button before interaction. Barely off the page.
- **Raised** (`0 1px 2px rgba(15,15,18,0.04), 0 6px 16px -4px rgba(15,15,18,0.10)`): the default lift for a card, KPI tile, or primary button — one clear step off the ground.
- **Floating** (`0 4px 10px rgba(15,15,18,0.06), 0 16px 36px -8px rgba(15,15,18,0.16)`): a hovered/lifted element, or a card that owns attention.
- **Glass** (`0 8px 20px rgba(15,15,18,0.10), 0 28px 60px -12px rgba(15,15,18,0.28)`): a modal, dropdown, popover, or the command palette — always paired with `backdrop-blur` and a translucent fill.

### Named Rules
**The Functional Glass Rule.** Translucency + `backdrop-blur` (`.glass`, the sidebar's mobile drawer) is reserved for chrome with real content behind it to blur — modals, dropdowns, popovers, the notifications panel, the mobile nav drawer. It is never applied to a static panel purely for a frosted look; that reads as decoration, which the floor bans.
**The No-Colored-Rail Rule.** A left-border or top-border color stripe (the KPI tile's old 4px verdict rail) is retired. Status now reads through a tinted icon chip (`KpiStatus` — an icon in a tinted circle) or a chip's own fill/border color, never a bare stripe.

## Shapes

Corners open further than the incumbent system: `sm` 14px, default 16px, `md` 18px, `lg` 22px, `xl` 30px — soft, generous, and paired with shadow rather than a heavy border. Buttons and chips stay full-pill (`rounded-full`); cards, inputs, and KPI tiles sit in the 16–22px range; the largest radius is reserved for a small number of prominent containers. Borders, where they remain (table rules, input edges, `.glass`'s 1px edge), are always 1px and drawn from the softened hairline/border tokens — never the old 1.5–3px ladder.

## Components

### Buttons
- **Shape:** full pill (`rounded-full`).
- **Primary:** ink fill, page-color text, `shadow-raised` at rest; on hover, lifts one pixel and swaps to gold fill with `shadow-floating`; on press, settles back down to `shadow-soft`. Depth marks the action, not a border swap.
- **Gold:** the inverse of primary (gold at rest, ink on hover) — used where gold is the default emphasis rather than an accent-on-touch.
- **Ghost:** no chrome at rest; a soft `ink-100` tint (6% opacity) fills on hover, 10% on press — Apple's "plain" button convention.
- **Quiet / Danger:** text-only at rest, tinted background on hover (`ink-850` / `band-critical` at 10–15% opacity).

### Chips
- **Style:** full pill, 1px border (70% opacity) or borderless-with-fill for gold/neutral variants, `font-semibold`, no forced uppercase.
- **State:** tone-specific text/background pairs at low fill opacity (10%) for status chips (band colors); solid fill for the gold chip variant.

### Cards / Containers
- **Corner Style:** `rounded-lg` (22px).
- **Background:** `ink-900` (white surface).
- **Shadow Strategy:** `shadow-raised` plus a 1px hairline border — the shadow carries the lift, the hairline keeps the edge crisp at close range.
- **Border:** 1px, `ink-800` (hairline).
- **Internal Padding:** 16px body, 20px/14px header.

### KPI Tiles
- **Corner Style:** `rounded-md` (18px).
- **Shadow Strategy:** `shadow-raised`, same as a card.
- **Status:** a `KpiStatus` chip — a tone-tinted circle (10% fill) holding a matching lucide icon (`CheckCircle2` / `AlertTriangle` / `XCircle`) — top-right, replacing the retired colored rail. Neutral tone renders no chip.
- **Value:** Archivo, 25px, `font-black`, tabular numerals at 112% stretch.

### Inputs / Fields
- **Style:** `ink-700` border, `shadow-soft` at rest, `rounded-md` (18px).
- **Focus:** border darkens to `ink-500`, shadow steps up to `shadow-raised`, plus a soft `accent`-tinted focus ring (10% opacity) — no hard 2px border swap.

### Navigation (Sidebar)
- **Style:** the one dark region in the app — `rgba(15,15,18,0.92)` fill over `backdrop-blur`, the same vibrancy material as `.glass`, not a flat solid. A soft trailing-edge shadow separates it from the canvas instead of a hard border.
- **Default / hover / active:** default text is a muted light gray; hover tints the row background; the active item is a full gold pill (no separate rail).
- **Icons:** lucide-react, one consistent stroke weight (1.75), replacing the previous Unicode-glyph icon map.
- **Mobile:** collapses entirely below `md`; a hamburger button opens it as a glass overlay drawer over a blurred scrim, closing on navigation or an outside tap.

### Glass Surfaces (Modal, Command Palette, Notifications, Mobile Drawer)
Translucent fill (`ink-900/85` or the sidebar's own tint) + `backdrop-blur-glass` (20px) + `shadow-glass`, 1px `white/10` border. The one place in the system where blur is load-bearing rather than cosmetic — each of these floats over real page content.

## Do's and Don'ts

### Do:
- **Do** use a shadow token (`soft`/`raised`/`floating`/`glass`) for every new elevated surface — never a border-weight step to signal "this is raised."
- **Do** reserve `.glass`/`backdrop-blur` for chrome that floats over real content (modals, dropdowns, popovers, the mobile nav drawer).
- **Do** keep headings sentence-case; reserve uppercase tracking for `.label`/`.kpi-label`/`.section-title`/`.sidebar-group`-style grouped list headers.
- **Do** use lucide-react (or an equivalent real icon library) at one consistent stroke weight for any new icon; never a Unicode glyph or emoji.
- **Do** keep every money or count value in tabular numerals (`.num`/`.tabular`/`.kpi-value`).

### Don't:
- **Don't** restyle, retint, or reassign the band (status) or division colors for aesthetic reasons — they are data encodings, validated for contrast and CVD-safety, fixed order, never cycled.
- **Don't** apply `backdrop-blur`/translucency to a static, non-floating panel — that is decoration, not the glass material this system defines.
- **Don't** reintroduce a colored border-left/top rail as a status indicator — use a tinted icon chip instead.
- **Don't** revert to the pre-redesign 1.5–3px border ladder for hierarchy; borders that remain are always 1px, drawn from the hairline/border tokens.
