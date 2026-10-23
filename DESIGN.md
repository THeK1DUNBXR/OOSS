# DESIGN.md: Kaizen Glass (Zen 360)

Read this before building any Zen 360 frontend. It describes the design system as it exists in the prototype source, not an ideal. Where the source is silent the text says **not specified**. Where the source contradicts the owner's decisions the text says so in section 10.

## 0. Sources and how to use this file

| Ref | Source                                                                                                                      | What it is                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| SRC | Artifact `https://claude.ai/artifact/6qVSdzK1XYGMAtC2deCUJE` (version 1792538168-3a83), files as loaded by its `index.html` | The clickable prototype. Source of every value and class name in this file.               |
| P1  | Project doc `claude/ui-redesign-plan.md` (19 Oct 2026)                                                                      | Direction, voice, modes, materials, motion intent.                                        |
| P2  | Project doc `claude/streamline-plan.md` (20 Oct 2026)                                                                       | Module set, navigation, roles, phone scope. Section 0 overrides sections 2 to 4 on names. |
| P3  | Project doc `claude/zen-decisions.md` (20 Oct 2026)                                                                         | Decision IDs (D-xx). Several are grouping-sensitive; see section 10.                      |

Rules for the agent:

1. Load CSS in the same order `index.html` does (section 0.2). Later rules win.
2. Use the custom property names in `design/tokens.css` (`var(--ink)`, `var(--f-ui)` and so on). Do not invent new names when one exists.
3. `design/tokens.json` mirrors the same names for non-CSS consumers. If the two disagree, `tokens.css` as loaded by the prototype is the reference.
4. Do not copy prototype example values (names, amounts, dates, vendors) into product code. Section 8 lists the rules.
5. The prototype has a number of duplicate and overriding rules. Prefer the Kaizen layer (`css/kaizen.css`) and the component files over `page.css` when they conflict, and flag the conflict rather than silently choosing.

### 0.1 Files that matter

- Tokens, base, colour, type, motion, glass, fonts and the Kaizen, Fusion and late layers: `css/*.css` and `fonts/fonts.css` (see 0.2).
- Capsule, motion, router and the module-loading scripts: root `nav.js`, `motion.js`, `router.js`, `modules-page.js`, plus `app/loader.js` and `app/modules.js`.
- Module CSS and JS: `app/<module>/` (Requests and Profile share `app/requests/kit.css` and `kit.js`; Approvals is `app/approvals/`; Home is `app/home/`; Finance tables and figures are `app/finance/finance.css`).

**Duplicate files.** The artifact also contains root-level copies of several stylesheets (`color.css`, `bold.css`, `glass.css`, `kaizen.css`, `kaizen-views.css`, `fusion.css`, `fusion-motion.css`, `motion.css`, `nav.css`, `type.css`, `font.css`, `fix-chrome.css`, `router.css`, `late.css`) and `brand/`. `index.html` does **not** load the root-level copies of these stylesheets. Ignore them. Root-level `nav.js`, `motion.js`, `router.js`, `modules-page.js`, `fusion-motion.js` **are** loaded. Example: the root `css/color.css` sets `--bg: #F6F4EE`, but that copy is never loaded, so the effective light background is `#FFFFFF` from `css/tokens.css`.

### 0.2 Load order (from index.html)

`css/tokens.css`, `css/page.css`, `css/color.css`, `css/nav.css`, `css/type.css`, `css/bold.css`, `css/motion.css`, `css/router.css`, `css/glass.css`, `css/font.css`, `fonts/fonts.css`, `css/kaizen.css`, `css/kaizen-views.css`, `css/fusion.css`, `css/fusion-motion.css`, `css/fix-chrome.css`, `css/views/fix-ops.css`, `css/page-late.css`, `css/late.css`, `plan/plan.css`. Scripts: `app/loader.js`, `nav.js`, `motion.js`, `router.js`, `modules-page.js`, `plan/features.js`, `plan/plan.js`, `fusion-motion.js`; `app/modules.js` is written first by an inline script.

The page sets `data-brand="kaizen"` on `<html>` and `lang="en-IN"`.

---

## 1. Principles

Each rule cites its source. Where the prototype does not fully follow a rule, section 10 says so.

1. **Ink and one signal yellow.** Text and structure are ink (`#0F0F12` light, `#F2F2F4` dark). Signal yellow `#FFC20E` is the only brand accent. (P1 "Current direction"; SRC `css/tokens.css` `--ink`, `--accent-fill`.)
2. **One yellow per surface.** A surface carries one yellow hint: the primary action, the current-place dot, or a count. Do not stack yellow hints. (P1 "Kaizen"; SRC `css/fusion.css` primary gradient; `css/nav.css` `.zt.cur::before`.) Note: `.badge` also uses yellow fill (SRC `css/page.css`), so a count badge and a primary action on the same surface breaks this rule.
3. **Division colours are chart data only.** They never appear in the capsule, the toolbar, buttons, or chrome. (P1 "Colour in data"; P3 D-09 item C6.) Violated in the prototype; see section 10.
4. **Words in Poppins, figures in Archivo.** Figures, money, codes and timestamps use the Archivo Fig face with tabular numerals. (P1 "Type"; SRC `css/font.css`, `css/kaizen.css`.)
5. **Glass is the material.** Surfaces use a five-step glass ladder (ultrathin, thin, regular, thick, chrome) with real `backdrop-filter` blur, gradient hairline edges, and an inset specular highlight. Nested rows stay flat. (P1 "Materials"; SRC `css/tokens.css` `--mat-*`, `css/glass.css`.)
6. **Light is the default. Dark is true OLED black.** Dark background is `#000000`. (P1 "Modes"; P2 "Owner decisions on record".) The prototype follows the OS by default; see section 10.
7. **Plain, true, British-Indian business English.** No exclamation marks, no slogans, no emoji. "Not yet measured" is never shown as zero. Empty states are true statements. Indian numbering (₹4,50,000) and date order (19 Oct 2026). (P1 "Voice and glossary".)
8. **Motion is one grammar.** One curve, 150 to 300 ms, exits faster than entrances, and only `transform`, `opacity`, `filter`, `clip-path` animate. Reduced motion removes travel. (SRC `css/motion.css` header; P1 "Motion".)

---

## 2. Tokens

### 2.1 How to use them

- Use `var()` with a token name from `design/tokens.css`, for example `var(--ink)`, everywhere. Never hard-code a colour that has a token.
- Colours in `css/tokens.css` use `light-dark(light, dark)`. Mode is set by `color-scheme` (set in `css/kaizen.css`). Do not add a second `prefers-color-scheme` block for a new token.
- Dark mode is also selected with `:root[data-theme="dark"]` and `:root[data-theme="light"]`.
- `css/tokens.css` says its values are "the resolved values of the previous cascade": it is a flattened snapshot. Some names are duplicates (for example `--f-ui`, `--font`, `--display`, `--serif` all resolve to Poppins). Use the role names in the tables below.
- Keep the legacy names only where the existing component code already uses them. Do not add new legacy names.

### 2.2 Colour: surfaces and ink

| Token           | Light                | Dark                    | Use                                         |
| --------------- | -------------------- | ----------------------- | ------------------------------------------- |
| `--bg`          | `#FFFFFF`            | `#000000`               | Page background. Set explicitly on `html`.  |
| `--surface`     | `#FFFFFF`            | `#0A0A0C`               | Opaque surface (lists, dialogs).            |
| `--ink`         | `#0F0F12`            | `#F2F2F4`               | Primary text and solid fills.               |
| `--secondary`   | `#3A3A45`            | `#A8A8B4`               | Secondary text.                             |
| `--tertiary`    | `#5A5A66`            | `#8E8E98`               | Tertiary text and meta labels.              |
| `--sep`         | `rgba(15,15,18,.14)` | `rgba(255,255,255,.10)` | Hairline separators.                        |
| `--fill`        | `rgba(15,15,18,.05)` | `rgba(255,255,255,.06)` | Hover and quiet fills.                      |
| `--fill-strong` | `rgba(15,15,18,.09)` | `rgba(255,255,255,.10)` | Stronger fill.                              |
| `--on-accent`   | `#0F0F12`            | `#0F0F12`               | Text on yellow.                             |
| `--link`        | `#0F0F12`            | `#F2F2F4`               | Links.                                      |
| `--ring`        | `#0F0F12`            | `#FFC20E`               | Global focus outline colour (`kaizen.css`). |

Additional ink roles exist (`--band-*` for the hero, `--pill-*` for pills, `--zg-*` for the capsule). Prefer the roles above.

### 2.3 Colour: signal and status

| Token                             | Light                            | Dark                               | Use                                                                                |
| --------------------------------- | -------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `--accent-fill`                   | `#FFC20E`                        | `#FFC20E`                          | Signal yellow fill (badge, primary button, capsule dot).                           |
| `--accent`                        | `#8A6A00`                        | `#FFC20E`                          | Yellow as a text or line colour. Use this, not the fill, for yellow text on light. |
| `--prim-top` / `--prim-bot`       | `#FFC20E` / `#FFB000`            | same                               | Primary gradient, used by `fusion.css` on `.btn.primary`.                          |
| `--prim-sh`, `--prim-hl`          | see tokens.css                   | see tokens.css                     | Primary button shadow and inset highlight.                                         |
| `--btn-hover` / `--btn-hover-ink` | `#FFD04D` / `#0F0F12`            | same                               | Primary button hover (page.css).                                                   |
| `--green`                         | `#1A7A4C`                        | `#30D158`                          | Positive status.                                                                   |
| `--orange` / `--orange-soft`      | `#A64E08` / `rgba(166,78,8,.09)` | `#FF9F0A` / `rgba(255,159,10,.12)` | Warning notice (`.notice`).                                                        |
| `--red`                           | `#AD2C22`                        | `#FF6961`                          | Overdue and hard errors.                                                           |
| `--gold` / `--gold-hi`            | `#C9A227` / `#FFC20E`            | same                               | Not specified for product use.                                                     |

Approvals and Home also define their own reds: `--ib-red` (`#B3261E` light, `#FF8A80` dark) and `--kv-red` (set in `app/home/home.css`). Prefer `--red`.

### 2.4 Colour: divisions (chart data only)

| Token               | Light     | Dark      | Division   |
| ------------------- | --------- | --------- | ---------- |
| `--c-money`         | `#2563EB` | `#60A5FA` | Finance    |
| `--c-people`        | `#0D9488` | `#2DD4BF` | People     |
| `--c-sales`         | `#DB2777` | `#F472B6` | Sales      |
| `--c-delivery`      | `#16A34A` | `#4ADE80` | Projects   |
| `--c-training`      | `#7C3AED` | `#A78BFA` | Academy    |
| `--c-communication` | `#EA580C` | `#FB923C` | Messages   |
| `--c-board`         | `#4F46E5` | `#818CF8` | Governance |
| `--c-admin`         | `#475569` | `#94A3B8` | Admin      |
| `--c-today`         | `#F59E0B` | `#FBBF24` | Home       |

The `--ct-*` variants are darker text-safe versions for light mode. They are not for chrome either. Division names in the source are the old room names (Money, Delivery, Training, Communication, Board). The current module names are in section 4.4.

### 2.5 Glass materials

| Token family        | Light / dark values (summary)       | Blur filter                 |
| ------------------- | ----------------------------------- | --------------------------- |
| `--mat-ultrathin-*` | bg `rgba(255,255,255,.22)` / `.025` | `blur(10px) saturate(130%)` |
| `--mat-thin-*`      | bg `.5` / `.06`                     | `blur(16px) saturate(140%)` |
| `--mat-regular-*`   | bg `.46` / `.045`                   | `blur(28px) saturate(160%)` |
| `--mat-thick-*`     | bg `.88` / `rgba(0,0,0,.84)`        | `blur(30px) saturate(160%)` |
| `--mat-chrome-*`    | bg `.88` / `rgba(0,0,0,.84)`        | `blur(30px) saturate(160%)` |

Each family has `-bg`, `-bd` (border), `-filter`, `-hl` (inset highlight), `-sh` (shadow), `-edge-top`, `-edge-bot`. Use the `--mat-*` family for new surfaces.

A second, parallel set exists: `--g-bg`, `--g-bg-float`, `--g-bd`, `--g-blur` (`blur(28px) saturate(160%)`), `--g-sh`, `--g-sh-float`, `--g-spec`, `--g-inset-bg`, `--g-inset-sh`, `--g-r`. `css/glass.css` uses these. The two families are not reconciled. See section 10.

Shadows: `--shadow`, `--g-sh` (`0 1px 2px ..., 0 12px 32px -16px ...`), `--g-sh-float` (larger). Values are in `css/tokens.css`.

**Living field.** `body::before` carries a radial yellow and navy aurora (tokens `--au-*`). `css/kaizen.css` reduces it to a faint yellow wash (`rgba(255,194,14,.10)` light, `.035` dark) and disables the slow drift with `animation:none!important`. Treat the field as static.

### 2.6 Radii, sizes and layout

| Token                | Value                                                                                                                       | Use                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `--g-r`              | `24px` (desktop). Kaizen layer sets `24px` at max-width 760px; `glass.css` sets `16px` there. Kaizen wins by cascade order. | Glass cards, toolbar, sheets.                         |
| `--r-tile`           | `18px`                                                                                                                      | Tiles.                                                |
| `--me-r` / `--me-r2` | `24px` / `18px` (scoped in `app/requests/kit.css`)                                                                          | Kit cards and textareas.                              |
| Stadium pill         | `border-radius:999px`                                                                                                       | Buttons, inputs in kit, capsule, tabs, chips, badges. |
| `--u`                | `8px`                                                                                                                       | Declared; usage not specified.                        |
| `--gl` / `--gr`      | `max(16px, safe-area)`                                                                                                      | Side gutters. The 16px phone gutter.                  |

Other fixed sizes in use (from the component files): toolbar 52px (`.toolbar`), capsule 46px tall (`.zpill`), capsule pill 32px (`.zt`), `.btn` 28px, `.search` 30px, `.badge` 18px, kit `.me-btn` 44px min, `.ib-btn` 36px min. Section 7 covers touch targets.

**Max widths.** `.col` is 992px in `page.css` and 1320px at min-width 68.75rem (1100px). `bold.css` later sets 1360px. Not specified which the product should use. See section 10.

### 2.7 Type tokens

| Token                                       | Value                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--t-meta`                                  | `.75rem` (12px)                                                                                                                                   |
| `--t-body`                                  | `.84375rem` (13.5px)                                                                                                                              |
| `--t-title`                                 | `.9375rem` (15px)                                                                                                                                 |
| `--t-lead`                                  | `1.0625rem` (17px)                                                                                                                                |
| `--t-sheet`                                 | `1.34375rem` (21.5px)                                                                                                                             |
| `--t-fig`                                   | `1.6875rem` (27px). Phone: `1.5rem` (24px).                                                                                                       |
| `--t-hero`                                  | `2.125rem` (34px). Phone: `1.875rem` (30px).                                                                                                      |
| `--track-h`, `--fd-track-l`, `--fd-track-m` | `-.02em`                                                                                                                                          |
| `--h-weight`, `--fd-weight`, `--hl-weight`  | `600` (headings and the `--hl-weight` token). The `.hl` element is forced to weight 500 by `font.css`, so the token is not what the figure shows. |

Full role table in section 3.

### 2.8 Motion tokens

| Token           | Value                        | Referenced by                                      |
| --------------- | ---------------------------- | -------------------------------------------------- |
| `--dur-1`       | `120ms`                      | `fusion-motion.css`, approvals, finance, kit       |
| `--dur-2`       | `200ms`                      | fusion-motion, plan, approvals, finance, home, kit |
| `--dur-3`       | `320ms`                      | fusion-motion, approvals, finance                  |
| `--dur-4`       | `480ms`                      | **not referenced** in the loaded sheets            |
| `--ease-out`    | `cubic-bezier(.16,1,.3,1)`   | many                                               |
| `--ease-in`     | `cubic-bezier(.4,0,1,1)`     | fusion-motion only                                 |
| `--ease-spring` | `linear(...)` (multi-stop)   | fusion-motion only                                 |
| `--m-ease`      | `cubic-bezier(0.16,1,0.3,1)` | `motion.css` (same curve as `--ease-out`)          |
| `--m-fast`      | `150ms`                      | `motion.css`                                       |
| `--m-out`       | `140ms`                      | `motion.css`                                       |
| `--m-in`        | `260ms`                      | **not referenced** in the loaded sheets            |

Section 6 covers use.

### 2.9 Tokens and `design/`

- `design/tokens.css`: the same custom property names as SRC `css/tokens.css`. Produced by the token agent.
- `design/tokens.json`: the same names with values, for tools that cannot read CSS. Produced by the token agent.
- The font files (`design/fonts/*.woff2`, `design/fonts/fonts.css`) are in the artifact and are self-hosted. Use them, not a CDN.

---

## 3. Typography

### 3.1 Faces

| Role                                       | Family                                                                                                  | Source                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Words (display, heading, body, labels)     | **Poppins** (400, 500, 600, 700; latin and latin-ext)                                                   | `--f-ui`, `--f-display`, `--font`                                                   |
| Figures (money, counts, codes, timestamps) | **Archivo Fig** (variable weight 100 to 900, width 112%, clamped). Falls back to Archivo, then Poppins. | `--f-num`, `--figfont`, `--mono` (name is misleading; this is not a monospace face) |
| System fallback                            | `system-ui, -apple-system, "Segoe UI", sans-serif`                                                      | tokens                                                                              |

Mono fallback `--ff-mono-fb` exists, but the product uses Archivo Fig for figures. Do not use a monospace face.

### 3.2 Roles

| Role                                                                 | Family      | Weight                                 | Size                                                         | Line height | Tokens / notes                                                            |
| -------------------------------------------------------------------- | ----------- | -------------------------------------- | ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------- |
| Hero (page title, `h1`)                                              | Poppins     | 600                                    | `--t-hero` 34px (phone 30px)                                 | 1.15        | `letter-spacing: var(--track-h)` (-.02em). Source: `css/type.css`.        |
| Date eyebrow (`.date`)                                               | Poppins     | 600                                    | `--t-title` 15px                                             | 1.35        | colour `--band-sec` on the hero                                           |
| Status sentence (`.status`)                                          | Poppins     | 400                                    | `--t-lead` 17px (phone 15px)                                 | 1.5         | `text-wrap: pretty`                                                       |
| Section heading (`.sechead h2`)                                      | Poppins     | 600                                    | `--t-lead` 17px                                              | 1.25        | letter-spacing -.02em                                                     |
| Sheet heading (`.shead h3`, `.ph`)                                   | Poppins     | 600                                    | `--t-sheet` 21.5px                                           | 1.25        |                                                                           |
| Panel heading (`.pn h3`)                                             | Poppins     | 600                                    | `--t-body` 13.5px                                            | 1.35        |                                                                           |
| Body                                                                 | Poppins     | 400                                    | `--t-body` 13.5px                                            | 1.4 to 1.5  | base `body` is `.875rem` (14px) in `font.css`, overridden by `type.css`   |
| Row title (`.t1`)                                                    | Poppins     | 400, `b` 600                           | `--t-body` 13.5px                                            | 1.4         | two lines, then clamp                                                     |
| Row meta (`.t2`, `.due`)                                             | Poppins     | 400                                    | `--t-meta` 12px                                              | 1.4         |                                                                           |
| Label, small caps (`.rbt .rl`, `.dtbl thead th`, `.me-lab`, `.hm-v`) | Poppins     | 600                                    | 11px                                                         | 1.3         | uppercase, letter-spacing .12em (`kaizen.css`). Kit uses .08em.           |
| Meta and axis text (`.tip`, `.key`, `.cap`, `.exlab`)                | Poppins     | 400 to 500                             | 12px                                                         | 1.4         | `--t-meta`                                                                |
| Headline figure (`.hl`)                                              | Archivo Fig | 500 (forced in `font.css`)             | `--t-fig` 27px (phone 24px); base 26px                       | 1.15        | `font-variant-numeric: tabular-nums`. The `.hs` sub-line is Poppins 13px. |
| Figure in table (`.dtbl td`, `.amt`, `.due`)                         | Archivo Fig | 500 to 600                             | 12 to 13px                                                   | 1.35        | tabular numerals                                                          |
| Chart text (`.chart text`)                                           | Archivo Fig | 500                                    | 12px                                                         |             | `font-stretch` pinned to 112%                                             |
| Button                                                               | Poppins     | 500 (ghost 500, `.btn` 500, `.zt` 500) | 13px (`.me-btn` 14px; `.me-btn-s` 13px; `.ib-btn` 13px, 600) | 1           |                                                                           |
| Code, IDs, timestamps                                                | Archivo Fig | 500                                    | 12px                                                         |             | `font.css` forces `slashed-zero` on `code`, `kbd`, `time`                 |

Known conflict: `font.css` forces figure stretch to 100%, while `kaizen.css` and `page.css` want 112%. Section 10.

---

## 4. Layout and navigation

### 4.1 App shell

- One HTML page (`index.html`). Routing is a hash router (`router.js`). Each route maps to a place or an area through `app/modules.js`.
- The registry has **18 places**: 5 personal (Home, Approvals, Requests, Profile, Settings) and 13 modules. It has 120 routes (places plus areas). Old hashes alias to new ones (for example `#inbox` resolves to `approvals`).
- Each place's `files` list in the registry loads its CSS and JS. `app/loader.js` injects them once.
- A **role** is chosen with "Viewing as" (Home bar). Ten roles exist, two of them `master` view (Founder, Finance head) and eight `focused`. Pins and visible modules depend on the role.

### 4.2 Desktop toolbar (>= 760px)

Source: `index.html` `header.chrome > .toolbar`; `css/page.css`; `nav.js`.

Order, left to right, as built:

1. `.where`: breadcrumb (prototype text is "Today", then the person's name). Hard-coded text in the prototype.
2. Go field: `.search` with the input `#q` (placeholder "Go to a module or screen…") and a `Ctrl K` hint. Opens the suggestion list `.cmdlist`.
3. Gateway button `#gobtn` (`.gobtn`). Hidden in the base stylesheet (`display:none`). Not specified when shown.
4. Prototype-only controls: `#statesBtn` ("States"), `.look`. Not for product.
5. `#homebtn` "Home" (`.inbox.tnav`). Hidden at max-width 1179px.
6. `#inboxbtn` "Approvals" with `.badge` count.
7. `#reqbtn` "Requests" with `.badge`.
8. `#avatar` (initials, 28px circle) with `#avmenu`: Profile, Settings.

P2 section 0 ("Desktop toolbar") says: Home · search/Go (Ctrl+K) · Approvals (count) · Requests · avatar (Profile, Settings). The build matches, plus the breadcrumb.

### 4.3 Bottom glass capsule (>= 761px, shown by `nav.js`)

Source: `nav.js` (builds `#zpill`), `css/nav.css`.

- Fixed at bottom, centred, 16px from the edge (plus safe area), 46px tall, `border-radius: 999px`, glass fill `--zg-glass` with `blur(28px) saturate(160%)`.
- Contents, left to right: up to **5 role pins** (from `ROLE_PINS` in `app/modules.js`, filtered by enabled modules), then **All modules**. A vertical separator, then the key hint bar (`.hintbar`).
- Labels are place names as text. **No icons.** Division colours are not used.
- Current place: a 2px ink outline (`inset box-shadow`) plus a 6px yellow dot (`::before`).
- Alt+letter jumps to a pin. Holding Alt underlines the accelerator letter (`.zn-alt` on `<html>`).
- Keyboard: arrow keys and Home/End move focus inside the capsule (`nav.js`).
- Hidden at max-width 760px (`display:none!important`). The hint bar and separator are hidden at max-width 1179px.

Example markup (rendered by `nav.js`):

```html
<nav class="zpill" id="zpill" aria-label="Modules">
  <div class="zmenu" role="group" aria-label="Your modules">
    <a class="zt cur" href="#finance" aria-current="page"
      ><span class="zw"><u>F</u>inance</span></a
    >
    <a class="zt" href="#people"><span class="zw">People</span></a>
    <a class="zt zall" href="#modules"><span class="zw">All modules</span></a>
  </div>
  <span class="zsep" aria-hidden="true"></span>
  <nav class="hintbar" id="hintbar" aria-label="Keyboard hints"></nav>
</nav>
```

### 4.4 Modules and personal places (as built)

**Personal (always available):** Home (`#home`), Approvals (`#approvals`), Requests (`#requests`), Profile (`#profile`), Settings (`#settings`).

**Modules (13)**, with the group they sit in on the All modules page:

| Group           | Module (route)            | Source file(s)                                                                        |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| Work            | Finance (`finance`)       | `app/finance/*`                                                                       |
| Work            | People (`people`)         | `app/people/*`                                                                        |
| Work            | Sales (`sales`)           | `app/sales/*`                                                                         |
| Work            | Marketing (`marketing`)   | `app/marketing/*`                                                                     |
| Work            | Projects (`projects`)     | `app/projects/*`                                                                      |
| Work            | Academy (`academy`)       | `app/academy/*`                                                                       |
| Talk and govern | Messages (`messages`)     | `app/messages/*`                                                                      |
| Talk and govern | Governance (`governance`) | `app/governance/*`                                                                    |
| Talk and govern | Equity (`equity`)         | `app/equity/*`                                                                        |
| Talk and govern | Strategy (`strategy`)     | `app/strategy/*`                                                                      |
| Run             | IT (`it`)                 | `app/it/*`                                                                            |
| Run             | Compliance (`compliance`) | `app/compliance/*`                                                                    |
| Run             | Admin (`admin`)           | `app/admin/*`; visible only to roles in `ADMIN_DUTY` (founder, hr-ops-head, it-owner) |

P2 section 0 names the module set: Finance, People, Sales, Marketing, Projects, Academy, Messages, Governance, Equity, Strategy, IT, Compliance, Admin. This matches. The earlier room names (Money, Delivery, Training, Communication, Board, Chairman's Office, Technology) are gone from the registry. Old hashes still resolve.

Pins per role (`ROLE_PINS`, up to 5): for example Founder: Finance, Sales, People, Projects, Governance. Read `app/modules.js` for the rest.

### 4.5 Phone tab bar (<= 760px)

Source: `index.html` `nav.tabbar`, `css/nav.css`, `css/page.css` (max-width 47.5rem), `css/late.css`.

Five tabs, in order (names as built):

| Label                          | `data-t`   | Route                    |
| ------------------------------ | ---------- | ------------------------ |
| Home                           | `today`    | `#home`                  |
| Approvals (count in `#tbadge`) | `inbox`    | `#approvals`             |
| Requests                       | `requests` | `#requests`              |
| Modules                        | `modules`  | `#modules` (All modules) |
| Profile                        | `me`       | `#profile`               |

Labels are text only (`.tabbar .tab svg` is hidden). Active tab: 6px yellow dot and `aria-current="page"`. Tab height is 44px only on touch landscape (`late.css`, `pointer:coarse` and max-height 31.25rem); the base tab height is not specified. The bar is also shown on those touch landscape screens.

P2 section 0 says phone tabs are "Home · Approvals · Requests · Go · Profile". The build labels the fourth tab **Modules**. See section 10.

### 4.6 Breakpoints

| Query                                  | Effect (source)                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| max-width 47.5rem (760px)              | Phone. Tab bar on, capsule off, toolbar nav links hidden, theme switch hidden, `--t-hero`/`--t-fig` reduced, `--g-r` 24px (kaizen layer wins). |
| max-width 66.25rem (1060px)            | Tablet. Toolbar grid tightens, `.look .ll` hidden, button padding reduced.                                                                     |
| max-width 73.6875rem (1179px)          | Capsule drops key hints and separator. Toolbar Home link hidden.                                                                               |
| min-width 68.75rem (1100px)            | Queue sticky, `.col` 1320px, queue rows use a three-column grid.                                                                               |
| max-width 79.9375rem (1279px)          | Additional tuning in `page.css` (not documented here).                                                                                         |
| pointer:coarse and max-height 31.25rem | Landscape touch phones: tab bar shown.                                                                                                         |
| prefers-reduced-motion                 | See section 6.                                                                                                                                 |
| prefers-reduced-transparency           | Glass becomes opaque (`glass.css`, `kaizen.css`).                                                                                              |
| forced-colors                          | Three rules exist. Not reviewed.                                                                                                               |

Phone gutter: 16px (`--gl` / `--gr`).

### 4.7 Page structure

**Home (`#home`)** is built from `app/home/home.js` on top of the legacy page in `#main`:

1. `.col` (the main column). Contains, in order: a `Viewing as` bar (`.hm-bar`, with `[ Example data ]` tag), the date line, the greeting `h1`, the status sentence with the cash figure.
2. Founder only (`#hmFounder`): "Your brief" (5 items, each marked read or open), "Since you last looked", "Also on Home", and a collapsed "Company scorecard against target" table.
3. Focused roles (`#hmFocus`): bands **Act** (things waiting on you, inline Approve for light asks with a 10-second undo), **Due** (dated obligations with owner and backup), **Watch** (figure tiles, each linking to a module).
4. Key figures ribbon (`#ribbon`), business panels (`.pn`), and the queue (`aside.queue`) with "Waiting on you" and "Coming up".

**Module home**: each module opens with its own home (for example `#finance`), then its areas. Area routes are listed in `app/modules.js`.

**All modules (`#modules`)**: search field, then group sections (Work, Talk and govern, Run) with row or card lists and a pin toggle per module (`.am-*`).

---

## 5. Components

Each entry gives purpose, variants, states and the real class names. Snippets are minimal and use only class names that exist in the source. Components are numbered 5.1 to 5.30.

Common states for interactive components: default, hover (`@media (hover:hover)`, 1px lift from `motion.css`), focus-visible (global outline, section 7), active (1px press), disabled (`opacity:.4` for `.btn`; dashed outline for `.me-btn[disabled]` and `.am-pin:disabled`).

### 5.1 Desktop toolbar

- **Purpose:** global chrome: where you are, Go to, Home, Approvals, Requests, account.
- **Classes:** `.chrome` (sticky, z 30, glass), `.toolbar` (52px grid), `.where`, `.tright`, `.inbox`, `.tnav`.
- **States:** `.chrome.scrolled` adds a stronger shadow. `aria-current="page"` on the current link (`.tright .inbox[aria-current]` shows an ink ring).
- **Snippet:**

```html
<header class="chrome" id="chrome">
  <div class="toolbar">
    <div class="where"><span>Home</span></div>
    <label class="search">…<input id="q" placeholder="Go to a module or screen…" /><kbd>Ctrl K</kbd></label>
    <div class="tright">
      <a class="inbox tnav" id="homebtn" href="#home">Home</a>
      <button class="inbox" id="inboxbtn" type="button">Approvals <span class="badge" id="badge">5</span></button>
      <a class="inbox tnav" id="reqbtn" href="#requests">Requests <span class="badge" id="rbadge" hidden>0</span></a>
      <div class="avwrap">
        <button class="avatar" id="avatar" aria-haspopup="menu" aria-expanded="false" aria-controls="avmenu">AR</button>
      </div>
    </div>
  </div>
</header>
```

### 5.2 Go field and suggestion list ("Go to", Ctrl K)

- **Purpose:** find a module or screen. Same index as All modules.
- **Classes:** `.search` (30px inset glass field), `#q`, `.cmdlist` (suggestion popover, 14px radius, z 50), `.cmdlist button` with `.cmn` (name) and `.cmc` (context). `.none` for no results.
- **Behaviour:** empty query shows up to 5 recent screens, then All modules and Roadmap. Enter opens the highlighted item. ArrowUp and ArrowDown move the highlight.
- **States:** `aria-expanded` on the combobox; highlighted row `.act`.
- **Snippet:**

```html
<label class="search"
  ><input
    id="q"
    role="combobox"
    aria-expanded="false"
    aria-controls="cmdlist"
    placeholder="Go to a module or screen…"
  /><kbd>Ctrl K</kbd></label
>
<div class="pop cmdlist" id="cmdlist" role="listbox"></div>
```

Note: Esc on Home opens All modules (`nav.js`), not a close-only action. This is intentional in the prototype, but is surprising. Section 10.

### 5.3 Avatar menu

- **Purpose:** Profile and Settings.
- **Classes:** `.avwrap`, `.avatar` (28px circle, initials), `.avmenu` (min 180px, 18px radius, z 80), items as `<a role="menuitem">`.
- **States:** `aria-expanded`, `.cur` on the avatar when on Profile or Settings. Arrow keys move, Escape closes and returns focus.
- **Snippet:**

```html
<div class="avwrap">
  <button class="avatar" id="avatar" aria-haspopup="menu" aria-expanded="false" aria-controls="avmenu">AR</button>
  <div class="avmenu" id="avmenu" role="menu" aria-label="Your account" hidden>
    <a role="menuitem" href="#profile" tabindex="-1">Profile</a>
    <a role="menuitem" href="#settings" tabindex="-1">Settings</a>
  </div>
</div>
```

### 5.4 Bottom glass capsule

- **Purpose:** the desktop and tablet module menu. Pins and All modules.
- **Classes:** `.zpill` (46px, fixed), `.zmenu`, `.zt` (pill, 32px, 14px side padding), `.zt.cur` (current), `.zt.zall` (All modules), `.zw` (label span), `u` (accelerator), `.zsep`, `.zbd` (count, Archivo, 12px), `.hintbar` / `.hi` / `kbd` (key hints).
- **Variants:** pinned place, current place, All modules.
- **States:** hover fill `--zg-fill`; focus-visible outline 2px yellow (see section 10); `.zn-alt` on `<html>` underlines accelerators.
- **Snippet:** as section 4.3.

### 5.5 Key hint bar (`.hintbar`)

- **Purpose:** show the keys that work on this screen. Lives inside the capsule on desktop.
- **Classes:** `.hintbar`, `.hi` (one hint: text plus `kbd`), `kbd` (Archivo, 18px, bordered).
- **Behaviour:** hints are removed from the end until they fit (`nav.js` `fitHints`). Two labels are rewritten: "Menus" becomes "Modules" and "Go" becomes "Back".
- **Snippet:** `<nav class="hintbar" id="hintbar"><span class="hi"><kbd>Ctrl K</kbd>Go to</span></nav>`

### 5.6 Phone tab bar

- **Purpose:** primary navigation on phone.
- **Classes:** `.tabbar` (fixed, glass, top border `--zg-line`), `.tab` (44px, equal flex), `.tab.on` or `[aria-current]` (yellow dot), `.tbd` (yellow count, 16px, hidden when zero).
- **Snippet:**

```html
<nav class="tabbar" aria-label="Main">
  <button class="tab on" data-t="today" aria-current="page">Home</button>
  <button class="tab" data-t="inbox">Approvals <span class="tbd" id="tbadge" hidden>0</span></button>
  <button class="tab" data-t="requests">Requests</button>
  <button class="tab" data-t="modules" aria-label="All modules">Modules</button>
  <button class="tab" data-t="me">Profile</button>
</nav>
```

### 5.7 Button: `.btn` (desktop base)

- **Purpose:** the base button in the page and legacy rooms.
- **Variants:** `.btn` (surface fill, 1px `--sep` border), `.btn.primary` (yellow gradient, ink text, via `fusion.css`), `.btn .hint` (keyboard hint inside a button, hidden at phone).
- **Size:** 28px tall, 8px radius, 13px, weight 500, padding 0 14px. Phone queue actions 40px (`page-late.css`).
- **States:** hover lift 1px; `.btn.primary:hover` uses `--btn-hover`; active press 1px; `:disabled` opacity .4 and no pointer events.
- **Snippet:**

```html
<button class="btn">Open</button> <button class="btn primary">Approve</button>
```

Note: the kit and Approvals use solid-ink pill buttons for primary actions (5.8). Two primary conventions exist. Section 10.

### 5.8 Pill buttons (kit, Approvals, Home)

Three families with the same shape (stadium, 999px) and different names:

| Family                            | Classes   | Primary                                              | Secondary                    | Min height                  |
| --------------------------------- | --------- | ---------------------------------------------------- | ---------------------------- | --------------------------- |
| Kit (Requests, Profile, Settings) | `.me-btn` | `.me-btn-p` (solid ink, white or black text by mode) | `.me-btn-s` (outline, 13px)  | 44px (`.me-btn-s` 40px)     |
| Approvals                         | `.ib-btn` | `.ib-primary` (solid ink)                            | `.ib-btn` (fill `--kv-fill`) | 36px; phone `--ib-tap` 44px |
| Home                              | `.hm-btn` | (none)                                               | `.hm-btn`                    | 44px                        |

- **States:** hover border to ink; active `scale(.98)` (kit); disabled dashed outline and ink-3 text (`.me-btn[disabled]`).
- **Snippet:**

```html
<button type="button" class="me-btn me-btn-p">Confirm</button>
<button type="button" class="me-btn me-btn-s">Cancel</button>
<button type="button" class="ib-btn ib-primary" data-quick="ask-id">Approve</button>
<button type="button" class="ib-btn" data-open="ask-id">Open</button>
```

### 5.9 Glass panel: `.pn`

- **Purpose:** a dashboard or content panel.
- **Classes:** `.pn` (12px base; glass in `glass.css`, 24px radius), `.pn h3` (heading with a 22px division-coloured square in `color.css`; see section 10), `.hl` (headline figure), `.hs` (sub-line), `.key` (chart legend), `.chart` (SVG), `.cap` (caption), `.dc` (nested tile).
- **States:** `.dc:hover` fill; `.dc:has(.nm)` flat tile with inset outline.
- **Snippet:**

```html
<section class="pn" aria-labelledby="p1">
  <h3 id="p1">Cash and runway</h3>
  <p class="hl">[figure]<span class="hs">[sub-line]</span></p>
  <p class="key">
    <span class="ky"><i class="sw"></i>[series]</span>
  </p>
  <span class="exlab">Example data</span>
</section>
```

### 5.10 Glass card and band (kit and Home)

- **Purpose:** grouped content on Requests, Profile, Settings, and Home bands.
- **Classes:** `.me-card` (padding 20px, 24px radius, `--kv-glass`), `.me-card.me-quiet` (dashed), `.hm-band` (18px 20px padding, 24px radius), `.hm-card`, `.hm-bh` (band header: `h2` plus count `.hm-bn`).
- **Snippet:**

```html
<section class="hm-band" aria-labelledby="hmAct">
  <header class="hm-bh">
    <h2 id="hmAct">Act</h2>
    <span class="hm-bn">2</span>
  </header>
  <ol class="hm-rows">
    …
  </ol>
</section>
```

### 5.11 Sheet, dialog, toast

- **Purpose:** overlays.
- **Sheet** `.sheet`: right-hand drawer, 400px, glass float, `.shead` (heading row), z 70.
- **Dialog (Go anywhere)** `.gw > .panel`: centred, 720px, 14px radius, z 80. Division letter picker with `.pl`, `.pr`, `.pf` footer.
- **Bulk dialog** `.bk > .bkp`: 480px, `h3`, `ul` of items, `.bkt` total, `.bka` actions. z 85.
- **Toast** `.toast`: fixed bottom 68px, z 95, status message. `.toast.hasact` with `.tclose` (late.css).
- **Undo strip (kit)** `.me-undo`: fixed, 16px inset, 9 second life; **Approvals** `.ib-undo`: ink pill with a transparent button.
- **States:** `.on` (open). Focus moves into the dialog; Esc closes (except Go anywhere, see 5.2).
- **Snippet:**

```html
<div class="bk" id="bulk" hidden>
  <div class="bkp" role="dialog" aria-modal="true" aria-labelledby="bkT">
    <h3 id="bkT">[title]</h3>
    <ul>
      …
    </ul>
    <div class="bkt"><span>Total</span><span>[figure]</span></div>
    <div class="bka">
      <button class="btn">Cancel <kbd>Esc</kbd></button><button class="btn primary">[action]</button>
    </div>
  </div>
</div>
```

### 5.12 List and row: `.list`, `.row`

- **Purpose:** dense lists (the Today queue, lists in modules).
- **Classes:** `.list` (12px base radius, `--surface`; the glass layer sets it to `--g-r`, 24px on desktop), `.row` (position relative), `.main` (flex row), `.txt` (text block), `.t1` (title, two-line clamp), `.t2` (meta), `.rt` (right column: figures), `.chip` (22px square avatar or count), `.sel` (selected, accent-soft fill), `.is-done` (replaced by `.done` line), `.open` (expanded `.drawer`).
- **Separator:** 1px `--sep` line between rows, inset 52px.
- **States:** hover fill (`rgba(118,118,128,.06)`), `.sel` (ink ring), `.is-done`, `.gone` (hidden).
- **Snippet:**

```html
<div class="list">
  <div class="row">
    <div class="main">
      <span class="chip">AB</span>
      <div class="txt">
        <div class="t1">[title] <b>[object]</b></div>
        <div class="t2">[raised by], [age]</div>
      </div>
      <div class="rt"><span class="amt">[figure]</span><span class="due">[date]</span></div>
    </div>
  </div>
</div>
```

### 5.13 Approval item: `.ib-row` (Approvals)

- **Purpose:** one ask waiting on you, with its decision actions.
- **Classes:** `.ib-list` (vertical list), `.ib-row` (24px radius), `.ib-row.is-over` (overdue), `.ib-open` (the clickable body), `.ib-r-top` (class and SLA line), `.ib-r-cls`, `.ib-r-title`, `.ib-r-why` (reason), `.ib-r-meta` (raised by, age, `.ib-amt`), `.ib-r-act` (actions), `.ib-chip` (`.ib-red`, `.ib-ok`), `.ib-tog` (checkbox).
- **Actions:** Approve (`ib-primary`), Open, Return (with a reason), Later (sets a return time). Money asks require a step-up code at commit (`app/approvals/approvals.js`: "Money asks the step-up code at the moment of commit").
- **States:** overdue (`.is-over`), done (replaced by `.done`), empty (`.ib-empty`), expanded (`.drawer`).
- **Snippet:**

```html
<ul class="ib-list">
  <li class="ib-row" data-id="ask-id">
    <button type="button" class="ib-open" data-open="ask-id" aria-label="Open: [title], from [raised by]">
      <span class="ib-r-top"
        ><span class="ib-r-cls">[class]</span><span class="ib-chip ib-red">Founder only</span></span
      >
      <span class="ib-r-title">[title]</span>
      <span class="ib-r-why">[reason]</span>
      <span class="ib-r-meta"><span>[raised by]</span><span>Today</span><span class="ib-amt">[figure]</span></span>
    </button>
    <span class="ib-r-act"
      ><button type="button" class="ib-btn ib-primary" data-quick="ask-id">Approve</button
      ><button type="button" class="ib-btn" data-open="ask-id">Open</button></span
    >
  </li>
</ul>
```

### 5.14 Status chips and pills

- **Pill with dot (kit):** `.me-pill.me-p-{kind}` with `<i aria-hidden="true">`. Kinds in use: `ok`, `wait`, `hold`, `bad`.
- **Chip (Approvals):** `.ib-chip` with `.ib-red` (overdue or founder only, red text and tint) or `.ib-ok` (green-style outline).
- **Chip (Home):** `.hm-chip` (26px, pill); `.hot` for overdue (red border).
- **Chip (row avatar):** `.chip` in 5.12 (not a status).
- **Snippet:**

```html
<span class="me-pill me-p-wait"><i aria-hidden="true"></i>Waiting on approver</span>
<span class="hm-chip hot">Overdue</span>
```

Use text in every chip. Colour alone never carries status (section 7).

### 5.15 Badge (count)

- **Purpose:** a count on a control.
- **Classes:** `.badge` (18px, yellow fill, ink text, 9px radius on desktop toolbar), `.tbd` (phone tab, 16px), `.zbd` (capsule count, text style). `.od` class on `.badge` makes it ink (overdue).
- **States:** hidden when zero (`hidden` attribute and `style.display`).
- **Snippet:** `<span class="badge" id="badge">5</span>`

### 5.16 KPI and figure tiles

- **Headline figure:** `.hl` (Archivo, 27px desktop) inside a `.pn` (5.9).
- **Watch tile (Home):** `.hm-tile > a.hm-tl` with `.hm-v` (label), `.hm-fig` (value; `.nm` for "Not yet measured"), `.hm-why` (one-line note), `.hm-go` (drill link).
- **Scorecard row (Home founder):** `.hm-tb` table, numeric cells `.n`, status text, "Trace" link to the KPI library.
- **States:** `.hm-fig.nm` shows "Not yet measured" in place of a figure. Never show zero for a missing value.
- **Snippet:**

```html
<li class="hm-tile">
  <a href="#[drill]" class="hm-tl">
    <span class="hm-v">[KPI name]</span>
    <span class="hm-fig nm">Not yet measured</span>
    <span class="hm-why">[one-line note]</span>
    <span class="hm-go">Open [module]</span>
  </a>
</li>
```

### 5.17 Data table: `.dtbl`

- **Purpose:** tabular figures.
- **Classes:** `.dtbl` (12px, collapsed borders), `thead th` (600, secondary, uppercase label style from `kaizen.css`), `tbody th` (500, ink), `td` (tabular Archivo Fig).
- **States:** row hover not specified.
- **Snippet:**

```html
<table class="dtbl">
  <thead>
    <tr>
      <th scope="col">Vendor</th>
      <th scope="col" class="n">Amount</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">[vendor]</th>
      <td class="n">[figure]</td>
    </tr>
  </tbody>
</table>
```

`.n` aligns numeric cells right (used in `home.js`; definition not located in the reviewed sheets).

### 5.18 Inputs and forms

- **Search field:** `.search` (toolbar, 30px, `--g-inset-bg`).
- **Kit field:** `.me-field` (grid wrapper), `label` with `.me-lab`, `input.me-in` (44px, pill), `textarea.me-in` (18px radius, 88px min height), `select.me-in`.
- **Check:** `.me-check` (44px row with 22px checkbox).
- **Radio pills:** `.me-radios` with `.me-radio` containing `input` and `span` (44px pill; checked = solid ink).
- **Approvals:** `.ib-inp` (input), `.ib-sel` (select), `.ib-seg` (segmented).
- **Errors:** `.me-err` with `role="alert"`, bordered in ink, prefixed `[ ! ]`. `aria-invalid="true"` on the field makes the border 2px ink.
- **Snippet:**

```html
<div class="me-field">
  <label for="from-date" class="me-lab">From</label>
  <input id="from-date" class="me-in" type="date" />
</div>
<p class="me-err" role="alert">Enter a date.</p>
```

### 5.19 Segmented control, tabs

- **Segmented (toolbar and charts):** `.seg2` with `role="tablist"`, buttons with `aria-selected`.
- **Approvals segments:** `.ib-segs` > `.ib-seg[aria-pressed]`.
- **Approvals tabs:** `.ib-tabs` > `.ib-tab[aria-selected]` (40px, pill).
- **Division tabs (legacy):** `.tab` (11.5px, weight 500).
- **Theme switch:** `.themeseg` (hidden at max-width 760px).
- **Snippet:**

```html
<div class="ib-segs" role="group" aria-label="Filter">
  <button type="button" class="ib-seg" aria-pressed="true">All</button>
  <button type="button" class="ib-seg" aria-pressed="false">Founder only</button>
</div>
```

### 5.20 Section header and band header

- **Section header** `.sechead`: flex row, `h2` (17px, 600), optional `.ct` count (tertiary), margin 32px top.
- **Band header** `.hm-bh`: `h2` plus `.hm-bn` count (Home).
- **Snippet:** `<div class="sechead"><h2>Waiting on you <span class="ct">5</span></h2></div>`

### 5.21 Home hero band

- **Purpose:** top of Today (Home) only. A smoked glass band behind the date, greeting and status sentence.
- **Classes:** `.col` with `::before` as the band; `.col > .date`, `.col > h1`, `.col > .status`, `.cashlink` (underlined figure link).
- **Look:** dark smoked glass, yellow glow top right (`kaizen` and `glass.css`). Band text colours `--band-ink`, `--band-sec`.
- **Note:** do not reuse as a general page header. It is specific to Home.

### 5.22 Notice and offline banner

- **Notice:** `.notice` (orange soft fill, 8px radius, 13px text, 12px margin top). Use for a warning that is not blocking.
- **Offline:** `#offline.offline` (`role="status"`, hidden by default, with a `.btn` "Retry now"). Shows a stale-data message and the "as at" time.
- **Snippet:**

```html
<p class="notice"><svg aria-hidden="true">…</svg>[warning text]</p>
```

### 5.23 Empty states

- **Kit:** `.me-empty` with `<b>` (title) and `<span>` (sub-line).
- **Approvals:** `.ib-empty` with `<b>` and optional `.ib-btn`.
- **Home:** `.hm-empty` (inside a band) and `.hm-end` / `.hm-endsub` (the closing line when a role is current).
- **Rule:** the message states what is true. Example: "Nothing is waiting on you." Not "All done!"
- **Snippet:**

```html
<div class="me-empty"><b>Nothing waiting</b><span>Asks raised by you appear here.</span></div>
```

### 5.24 "Example data" label

- **Purpose:** every screen with prototype data is labelled (P3 D-09).
- **Classes:** `.exlab` (inside a panel heading, 12px, tertiary), `.example` (footer, 11px, 40px top margin), `.hm-tag` (pill, `[ Example data ]`, in the Home bar).
- **Coverage:** the reviewed pages carry the label on Home, on the Finance business panel, and in the page footer. Not verified on every screen.
- **Snippet:** `<span class="exlab">Example data</span>`

### 5.25 Amount reveal gate (kit)

- **Purpose:** amounts on Profile and Requests are hidden on the device until revealed; each reveal is logged.
- **Classes:** `.me-amt` (figure), `.me-mask` (masked, `letter-spacing:.12em`), `.me-reveal` (bar), `.me-reveal-on` (revealed state), `.me-pin` (PIN form), `.me-help`.
- **Behaviour:** masked text is "₹ •••••" with `role="img"` and `aria-label="Amount hidden"`. Reveal asks for a 4-digit PIN (example only; the product uses the device PIN or biometric). Revealed state shows the time and "This reveal is logged", with "Hide amounts". A toast offers "Hide again".
- **Snippet:**

```html
<div class="me-reveal">
  <span class="me-pill me-p-hold"><i aria-hidden="true"></i>Hidden</span>
  <span>Amounts are hidden on this device until you reveal them.</span>
  <button type="button" class="me-btn me-btn-p">Reveal amounts</button>
</div>
```

### 5.26 Home bands: Act, Due, Watch rows

- **Purpose:** what needs you (Act), what is dated (Due), and figures you are accountable for (Watch).
- **Classes:** `.hm-rows` (list), `.hm-row` (grid 28px, 1fr, auto; `.is-hot` for overdue), `.hm-n` (number), `.hm-main` (link: `.hm-v` eyebrow, `.hm-t` title, `.hm-why` detail), `.hm-side` (chip and button), `.hm-more` (footer link).
- **Behaviour:** inline Approve on light asks; Undo for 10 seconds (`.hm-btn[data-undo]`).
- **Snippet:**

```html
<ol class="hm-rows">
  <li class="hm-row is-hot">
    <span class="hm-n" aria-hidden="true">1</span>
    <a class="hm-main" href="#approvals"
      ><span class="hm-v">[module] · Open</span><span class="hm-t">[title]</span><span class="hm-why">[detail]</span></a
    >
    <span class="hm-side"
      ><span class="hm-chip hot">Overdue</span
      ><button type="button" class="hm-btn" data-quick="ask-id">Approve</button></span
    >
  </li>
</ol>
```

### 5.27 Founder brief

- **Purpose:** five read-or-open items for the founder on Home.
- **Classes:** `.hm-brief` (list), `.hm-bi` (item, `.is-read`), `.hm-bt` (text), `.hm-link`, `.hm-btn[aria-pressed]` ("Mark read" or "Read"), `.hm-dig` (bullet list).
- **Snippet:**

```html
<ol class="hm-brief">
  <li class="hm-bi">
    <span class="hm-n" aria-hidden="true">1</span>
    <div class="hm-bt">
      <span class="hm-v">[item]</span><span class="hm-why">[text]</span><a class="hm-link" href="#[route]">[action]</a>
    </div>
    <button type="button" class="hm-btn" aria-pressed="false">Mark read</button>
  </li>
</ol>
```

### 5.28 All modules index

- **Purpose:** list and pin modules.
- **Classes:** `.dv-modules` (page), `.am-search` (48px pill input), `.am-sec` (group), `.am-lab`, `.am-cnt`, `.am-list` / `.am-row` (44px row), `.am-grid` / `.am-card` (24px radius card), `.am-cta`, `.am-h`, `.am-d`, `.am-pin[aria-pressed]` (32px pill toggle; disabled dashed).
- **Snippet:**

```html
<div class="am-search">
  <label class="am-lab" for="am-q">Find a module</label><input id="am-q" type="search" placeholder="Find a module" />
</div>
<section class="am-sec">
  <h2>Work <span class="am-cnt">6</span></h2>
  <ul class="am-list">
    <li>
      <a class="am-row" href="#finance"><span class="am-n">Finance</span><span class="am-c">[count or note]</span></a>
    </li>
  </ul>
</section>
```

### 5.29 Charts

- **Purpose:** trends, waterfalls, ageing bars.
- **Classes:** `.chart` (SVG container), `.chart text` (Archivo Fig 12px), `.key` (legend) with `.sw` (swatch) or `.kl` (line swatch), `.ky`. Animation classes `.m-wipe`, `.m-bar`, `.m-pop`, `.m-move` are added by `motion.js` only.
- **Colour:** division colour is the series colour here and nowhere else (P1, P3 D-09 C6). Set with `--series`.
- **States:** `.hit:focus-visible` on chart hit targets (stroke in series colour).
- **Snippet:**

```html
<figure class="chart" role="img" aria-label="[chart title]">…svg…</figure>
<p class="key">
  <span class="ky"><i class="sw"></i>[series name]</span>
</p>
```

### 5.30 Prototype-only controls (do not ship)

- **Classes and items:** `#statesBtn` ("States"), `.look` (theme and states), `.me-sw` ("[ Prototype: … ]" switches), `.ib-proto` ("Prototype controls" on approvals), the "Viewing as" role switch (`.hm-viewing`, `#hmRole`) when it is used as a demo control, and "Simulate" and "State" controls in approvals.
- **Rule:** remove from product or gate behind a dev flag. Do not copy them into new screens.

---

## 6. Motion

### 6.1 Tokens and use

| Use                                        | Token or value                                                                                | Source                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Hover lift and press (buttons, tabs, rows) | `translateY(-1px)` on hover (`@media (hover:hover)`); `translateY(1px)` on `:active`          | `motion.css`                                                                                     |
| Fast colour, background, shadow            | `--m-fast` 150ms, `--m-ease`                                                                  | `motion.css`                                                                                     |
| Capsule panel rise (legacy `.zpanel`)      | 120ms out, 280ms in, from `translateY(16px) scale(.96)`                                       | `motion.css` (the class is not produced by `nav.js`)                                             |
| Approval card expand                       | `grid-template-rows` 180ms (collapse), 300ms (expand)                                         | `motion.css`                                                                                     |
| Approval card content fade                 | 100 to 220ms, offset 40 to 70ms                                                               | `motion.css`                                                                                     |
| Approve, done line settles                 | 220ms clip-path and translate                                                                 | `motion.css` `m-done`                                                                            |
| Count roll                                 | 180ms                                                                                         | `motion.css` `m-roll`                                                                            |
| Rise on entry                              | 260ms, 10px                                                                                   | `motion.css` `m-rise`                                                                            |
| Chart first paint                          | wipe 400ms; bars 360ms staggered by 20ms; pop 260ms; move 300ms                               | `motion.css`, added by `motion.js`                                                               |
| Fast eased entry (general)                 | `--dur-2` 200ms, `--ease-out`                                                                 | many sheets                                                                                      |
| View transitions between places            | `view-transition-name` on the tab bar (`fusion-motion.css` line 75); other names not reviewed | `fusion-motion.css`, `fusion-motion.js`                                                          |
| Spring easing                              | `--ease-spring`                                                                               | defined and referenced only in `fusion-motion.css`; the component that uses it is not identified |

The owner's brief (P1) asks for staggered entrances and spring presses. The sheets confirm a stagger on chart bars and spring defined only in `fusion-motion.css`. Use the tokens; do not write new easing curves.

### 6.2 Rules

- One curve (`--m-ease` or `--ease-out`). Durations 120 to 300 ms. Exits faster than entrances.
- Animate only `transform`, `opacity`, `filter`, `clip-path`, and `grid-template-rows` for expand and collapse.
- Content is visible without JavaScript. Do not hide content at `opacity:0` waiting for an animation.
- The Home drift animation (`body::before`, 60s) is disabled by the Kaizen layer. Do not restore it.

### 6.3 Reduced motion (as in source)

`@media (prefers-reduced-motion: reduce)` in `motion.css`:

- All transitions on `.zi`, `.btn`, `.inbox`, `.ghost`, `.gobtn`, `.tab` set to `none`. Hover and press transforms set to `none`.
- Overlays (`.zpanel`) crossfade in 150ms `linear`, with no transform.
- Drawer expand and collapse: no transition. Card content: 150ms opacity crossfade.
- Done line: 150ms opacity fade.
- All `m-*` chart and entry animations set to `animation: none !important`.

Other reduced-motion blocks: `nav.css` (capsule transitions off), `fusion-motion.css` (two blocks), `glass.css` (drift only when motion is allowed, `prefers-reduced-motion: no-preference`), `page.css` (two blocks), and others. Test each new animation with the setting on.

`prefers-reduced-transparency: reduce` makes glass opaque (`glass.css`, `kaizen.css`). `@supports` without `backdrop-filter` also gets an opaque fallback.

---

## 7. Accessibility

### 7.1 Contrast

Ratios computed from the token hex values (WCAG 2.x relative luminance). These are token-level figures, not rendered-page measurements.

| Pair                                               | Ratio | Passes 4.5:1 text?                               |
| -------------------------------------------------- | ----- | ------------------------------------------------ |
| `--ink` `#0F0F12` on `#FFFFFF`                     | 19.1  | yes                                              |
| `--secondary` `#3A3A45` on white                   | 11.2  | yes                                              |
| `--tertiary` `#5A5A66` on white                    | 6.8   | yes                                              |
| `--accent` `#8A6A00` on white (yellow text, light) | 5.1   | yes (only this token for yellow text)            |
| `--accent-fill` `#FFC20E` on white                 | 1.6   | **no. Never text or a sole indicator on light.** |
| `#0F0F12` on `#FFC20E` (on-accent)                 | 11.8  | yes                                              |
| `--ink` `#F2F2F4` on `#000000`                     | 18.8  | yes                                              |
| `--secondary` dark `#A8A8B4` on black              | 8.9   | yes                                              |
| `--tertiary` dark `#8E8E98` on black               | 6.5   | yes                                              |
| `--accent-fill` `#FFC20E` on black                 | 13.0  | yes                                              |
| `--red` `#AD2C22` on white                         | 6.7   | yes                                              |
| `--ib-red` `#B3261E` on white                      | 6.5   | yes                                              |
| `--red` dark `#FF6961` on black                    | 7.5   | yes                                              |

Rule: use yellow as a fill, a dot, a ring or a count, with ink text on it. Yellow text on light fails.

### 7.2 Focus

- Global: `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }` (`kaizen.css`). Light ring is ink; dark ring is yellow.
- Overrides in `nav.css` use `outline: 2px solid #FFC20E` (capsule, avatar, toolbar links, All modules). On a light background a yellow outline is 1.6:1 against white, which fails the 3:1 non-text requirement. Use `var(--ring)`. Section 10.
- Search field: the field shows the focus ring (`.search:focus-within`), and the input itself has no outline.
- List rows: `.list .row:focus-visible` uses the ring, inset.

### 7.3 Touch targets

| Element                                                                                          | Minimum (source)                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Kit button `.me-btn`, input `.me-in`, check `.me-check`, radio `.me-radio span`, link `.me-link` | 44px                                                          |
| Home button `.hm-btn`, chip `.hm-chip` (26px)                                                    | 44px button; chip is not a target                             |
| Approvals button `.ib-btn`                                                                       | 36px desktop; `--ib-tap` 44px on phone                        |
| Capsule item `.zt`                                                                               | 32px (desktop only, a pointer device)                         |
| Phone tab `.tab`                                                                                 | 44px on touch landscape (late.css); base height not specified |
| Base `.btn`                                                                                      | 28px desktop; 40px in phone queue actions                     |
| Avatar                                                                                           | 28px circle (desktop)                                         |

Rule: 44px for every touch control on phone. The base `.btn` at 28px is not safe on phone unless overridden.

### 7.4 Semantics and keyboard (as built)

- Go field: `role="combobox"`, `aria-expanded`, `aria-controls` the listbox.
- Capsule: `aria-label="Modules"`; current item `aria-current="page"`.
- Avatar: `aria-haspopup="menu"`, `aria-expanded`; menu items `role="menuitem"`; arrow keys, Escape returns focus.
- Segmented and tabs: `role="tablist"` and `aria-selected`; toggles `aria-pressed`.
- Errors: `role="alert"` (kit). Status messages and toasts: `role="status"`.
- Amount mask: `role="img"` and `aria-label="Amount hidden"`.
- Screen-reader-only text: `.sr`.
- Accelerators: Alt plus letter jumps to a pinned module (`nav.js`).
- Ctrl K opens Go to.
- The approval card "Open" link names the object: `aria-label="Open: [title], from [raised by]"`.

### 7.5 Colour and status

- Do not signal status by colour alone. Chips and pills carry text (5.14).
- Overdue uses red text and a text label ("Overdue").

---

## 8. Content rules

| ID   | Rule                                                                                                                                                                                                                                                                                                                                                                         | Source                                         | Status in prototype                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-09 | Every screen with prototype data carries an "Example data" label. Example names are only company-fact names or generic roles. Company facts in the decisions doc: Arvind Raghavan, Meenakshi S., Karthik S., Lakshmi N.                                                                                                                                                      | P3 D-09                                        | **Violated.** Other names appear in `app/modules.js` (Revathi P., Divya R., Prakash V., Selvi M., Priya V., Arun K.), `app/requests/kit.js` (Saranya P., Vignesh R.), and `app/home/home.js` (vendor "Rajan Print Works"). |
| D-09 | Company location is **Madurai**. Do not use Chennai.                                                                                                                                                                                                                                                                                                                         | P3 D-09 (C1, C-11)                             | **Violated.** "travel to Chennai" appears in approvals example data; "Chennai Cloud Services" appears as a vendor.                                                                                                         |
| D-36 | Tally F-keys stay in Money. Keyboard in Money: F4 Contra, F5 Payment, F6 Receipt, F7 Journal, F8 Sales, F9 Purchase, with Enter, Esc and J/K. Browser behaviour of F5 and F6 inside Vouchers is untested.                                                                                                                                                                    | P3 D-36; P1 glossary; `app/finance/ledger.js`  | Built as stated. Test F5 and F6 in browsers before M-14 is final.                                                                                                                                                          |
| D-36 | Chairman room (Governance/Strategy): mnemonics only, never F-keys.                                                                                                                                                                                                                                                                                                           | P3 D-36 (C11)                                  | Not checked.                                                                                                                                                                                                               |
| D-01 | The founder may approve his own payout as a visibly logged founder exemption. Payouts above ₹2,00,000 route to the founder.                                                                                                                                                                                                                                                  | P3 D-01 (decided); P2 owner decisions          | Built as "Approve with exemption" with a logged note. Routing rule in approvals example text.                                                                                                                              |
| D-02 | Phone scope: Home, Approvals and Inbox, self-service, batch attendance, call log and follow-ups, capture a lead. Other screens are responsive, not phone-designed.                                                                                                                                                                                                           | P3 D-02 (default, confirm); P1 owner decisions | Phone flags per area in `app/modules.js`. Confirm before adding phone screens.                                                                                                                                             |
| D-35 | The "₹50,000" bulk-approve limit has no source. Do not ship a figure.                                                                                                                                                                                                                                                                                                        | P3 D-35 (open)                                 | The bulk dialog text says "under ₹50,000". Remove or set by owner.                                                                                                                                                         |
| D-14 | Approval thresholds are not set in any source. Show "Not set", not a figure.                                                                                                                                                                                                                                                                                                 | P3 D-14                                        | Prototype shows figures. Treat as example.                                                                                                                                                                                 |
| D-39 | Navigation: bottom capsule is the working answer (up to 5 role pins and All modules). Left rail is not built.                                                                                                                                                                                                                                                                | P3 D-39 (default, open)                        | Built as the capsule.                                                                                                                                                                                                      |
| P1   | Terms: **Approve** names its object; **Return** always with a reason; **Later**, never "Snooze"; **Payout** is money out; **Receipt** is money in; **Raised by** (never "Asked by"); **Founder exemption**; **Overdue**; **Learner** (Academy); "Go to a task" is the search; "Go anywhere" is the division picker; unbuilt items read "[Task] isn't in this prototype yet." | P1 glossary                                    | Mostly followed. No "Snooze" or "Asked by" in the source.                                                                                                                                                                  |
| P1   | Finance terms (DSO, DPO, TDS, GSTR-3B, P10, P90) keep their names with a one-line plain tooltip.                                                                                                                                                                                                                                                                             | P1 glossary                                    | Tooltip coverage not verified.                                                                                                                                                                                             |
| P1   | "Not yet measured" is not zero.                                                                                                                                                                                                                                                                                                                                              | P1 voice                                       | Followed in Home tiles and scorecard.                                                                                                                                                                                      |
| P1   | No exclamation marks, slogans or emoji.                                                                                                                                                                                                                                                                                                                                      | P1 voice                                       | Not verified across all strings.                                                                                                                                                                                           |
| P1   | Research visual notes (serif announcements, "red is rare", "Exchange") are superseded by Kaizen Glass.                                                                                                                                                                                                                                                                       | P3 D-09 (C6)                                   | Superseded.                                                                                                                                                                                                                |

---

## 9. Do and do not

**Do**

1. Use `var(--…)` from `design/tokens.css`. Add new tokens only when none exists, and name them by role.
2. Use Poppins for words and Archivo Fig for every figure, amount, code and timestamp, with tabular numerals.
3. Build surfaces from the `--mat-*` ladder (or `.pn` and `.me-card`). Use the blur tokens; do not hand-write blur values.
4. Keep one yellow hint per surface: the primary action, the current-place dot, or one count.
5. Make every touch target at least 44px on phone, and label every icon-only control.
6. Show "Not yet measured" for missing figures. Show a true empty state with a reason.
7. Add the "Example data" label to any screen that shows prototype or sample data. Use company-fact names only.
8. Animate only transform, opacity, filter, clip-path and grid rows, with the named durations. Give every animation a reduced-motion path.
9. Put money decisions in Approvals with a step-up code at commit and no undo tap (P3 D-13 grouping note; section 10).
10. Test both themes (light, true-black dark) and 1440px and 390px widths before handing over.

**Do not**

1. Do not use yellow text on light backgrounds, or yellow as the only indicator of state.
2. Do not use a division colour in chrome, menus, buttons or section headers. Chart series only.
3. Do not invent a new button, card or chip family. Use the families in section 5 and mark a gap as "not specified".
4. Do not use Divya, Revathi, Anna Nagar, Chennai, Saranya, Vignesh or any name not in the company facts.
5. Do not show amounts that are not revealed. Use the reveal gate (5.25).
6. Do not put F-keys in the Chairman or Governance rooms. Do not change the Money F-key map.
7. Do not restore the animated field, or add a parallax effect.
8. Do not use `#FFC20E` as a focus outline on light. Use `var(--ring)`.
9. Do not ship the prototype-only controls in 5.30.
10. Do not write "Snooze", "Asked by", "Chennai" or exclamation marks into copy.

---

## 10. Open questions and defects

### 10.1 Open decisions (owner)

1. **D-39 navigation.** The capsule is built. The left rail is not built. P2 and P3 record the capsule as the working answer, with the rail as an owner question. Note: P3 titles D-39 "Team status", but its navigation text is grouped under it by the automatic grouping. Confirm the decision ID.
2. **Phone tab names.** P2 section 0 says Home, Approvals, Requests, Go, Profile. P2 section 4 and P3 D-02 say Today, Inbox, Me, Go. The build says Home, Approvals, Requests, Modules, Profile. Pick one set; the build uses "Modules" for the All modules tab.
3. **D-02 phone scope.** The default is recorded, but the owner has not confirmed it. Chairman brief on phone (D-02 item C10) is unresolved.
4. **D-03 Inbox owner.** P2 makes Approvals the one place to decide asks. The prototype matches that. Confirm the Home inline Approve is allowed.
5. **D-01 founder exemption.** Decided. The exemption appears as a logged note on the Approve action, but the logging and expiry rules are not specified (P3 D-01 item C12 asks whether it expires).
6. **D-10 and D-11 (statutory rule approval and payroll engine).** Open. Affects Compliance and People copy.
7. **Undo after approve.** The approvals code offers a 10-second undo on approve. P3 says money must not be undone by a tap. I did not confirm that money asks are excluded in the code. P3 lists this under D-13 by automatic grouping; confirm the decision ID.
8. **Bulk approve (D-35).** Figure unsourced.
9. **Keyboard collisions (D-36).** F5 and F6 in browsers untested.

### 10.2 Naming conflict

- P2 section 4 ("Navigation") still uses the old phone tab names (Today, Inbox, Me, Go). Section 0 overrides it. Section 4 should be updated to avoid two sources of truth.

### 10.3 Visual and system defects found in source

1. **Division colours in chrome.** `css/color.css` puts division colours on panel heading squares (`.pn h3::before`), queue row chips (`.row .chip`), and "Coming up" date tiles (`.up::after`). P1 says division colours are chart data only.
2. **Two primary button conventions.** `fusion.css` makes `.btn.primary` a yellow gradient with ink text. The kit (`.me-btn-p`) and Approvals (`.ib-primary`) use solid ink. Pick one for product.
3. **Yellow focus outlines on light.** `nav.css` uses `#FFC20E` outlines (capsule, avatar, toolbar, All modules). Fails 3:1 on white (ratio 1.6). Use `var(--ring)`.
4. **Two glass token families.** `--g-*` (glass.css, kaizen.css) and `--mat-*` (tokens.css, fusion.css) define the same idea with different values. Pick one for product.
5. **Corner radius conflict on phone.** `glass.css` sets `--g-r` 16px at max-width 760px; `kaizen.css` sets 24px at the same width and wins. Document 24px.
6. **Figure stretch conflict.** `font.css` forces Archivo figure stretch to 100%; `kaizen.css` and `page.css` pin 112%. The face is clamped to 112% in `kaizen.css`, so the visible result is likely 112%, but the rules disagree.
7. **Stale comment.** `css/font.css` says "Option 1: Geist (default)". The active faces are Poppins and Archivo. Do not follow the comment.
8. **Light default vs OS-following.** `kaizen.css` and `tokens.css` follow `prefers-color-scheme` unless `data-theme` is set. P1 says light is the default and dark is opt-in. Decide and set the default.
9. **Max width.** `.col` is 992px (`page.css`), 1320px at 1100px+ (`page.css`), and 1360px in `bold.css`. Pick one.
10. **Duplicate and layered rules.** Twenty stylesheets load in sequence, with many `html:root:root:root` overrides. New screens should use the newest layer and the kit, not patch old rules.
11. **Unused tokens.** `--dur-4`, `--m-in` are not referenced in the loaded sheets. `--u` is declared with no use found.
12. **Hard-coded example text on Home.** The date "Sunday, 18 October", "09:04" as the as-at time, "Since you last looked, Mon 19 Oct", and "97% of plan" are literal strings in `home.js`. They are example data and must come from data in product.
13. **Prototype controls in production markup.** `#statesBtn`, `.me-sw`, `.ib-proto`, and the role switch remain in the markup (section 5.30).
14. **Esc on Home** opens All modules (`nav.js`). Unexpected for a close key.
15. **Approvals count.** `index.html` has a literal badge value "5" (`#badge`) that `nav.js` replaces at runtime from the approvals count. The artifact's summary text reports a mismatch between the header count and a keyboard footer count. Not verified in a browser.
16. **Not rendered.** I did not load the page in a browser. Visual defects here come from reading the CSS and JS. Verify layout at 1440px and 390px before signing off.

### 10.4 Not specified in source

- Contrast of the dark-mode `--orange`, `--green` and `--gold` text: not computed. Only the pairs in section 7.1 were checked.
- Hover state of table rows (`.dtbl`).
- Exact spacing scale. `--u` is declared, usage not found. Use the sizes in the component files.
- Icon set: SVG icons are inline in `index.html` (16 by 16 viewBox, stroke icons). No icon library is loaded. Not specified for product icons, and the phone capsule has no icons by rule.
- Toast position and copy rules beyond the sample.
- Print styles.
- Internationalisation beyond `lang="en-IN"` and Indian numbering.
- Keyboard behaviour inside dialogs beyond Esc and focus return.
