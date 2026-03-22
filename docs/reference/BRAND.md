# Arkova Design System — "The Precision Engine"
_Last updated: 2026-03-22 | Applies to: arkova.ai (marketing) + app.arkova.ai (product)_

## Creative North Star

**"The Precision Engine."** The visual identity should feel engineered, not designed. High-contrast typography, sharp edges, tonal depth, and light as a structural element. Every element should feel machined with purpose. We do not use containers to trap content — we use light play, subtle gradients, and depth to guide the eye.

**Anti-template mandate:** Avoid rounded-2xl card grids, pill badges, floating shield icons, and any pattern that screams "AI-generated landing page." If it looks like a Tailwind template, it's wrong.

---

## Colors

### Primary Palette (Dark Mode — Default)

| Token | Hex | Usage |
|-------|-----|-------|
| `cyber-bg` | `#0a0f14` | Base background |
| `cyber-bg-light` | `#0f1a22` | Footer, elevated sections |
| `cyber-bg-card` | `#0d1820` | Card/panel backgrounds |
| `cyber-cyan` | `#00d4ff` | Primary accent, buttons, links, highlights |
| `cyber-cyan-dim` | `#00a3cc` | Secondary cyan for gradients |
| `cyber-teal` | `#00e5c8` | Gradient endpoint, success states |

### Opacity Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `cyber-cyan-border` | `rgba(0, 212, 255, 0.25)` | Card borders, dividers |
| `cyber-cyan-glow` | `rgba(0, 212, 255, 0.15)` | Ambient glows |
| `cyber-cyan-muted` | `rgba(0, 212, 255, 0.08)` | Subtle backgrounds |

### Legacy Palette (App — being migrated)

| Token | Hex | Usage |
|-------|-----|-------|
| `arkova-steel` | `#82b8d0` | Former primary (being replaced by `cyber-cyan`) |
| `arkova-charcoal` | `#303433` | Sidebar background |
| `arkova-ice` | `#dbeaf1` | Light backgrounds (light mode only) |

---

## Typography

| Token | Family | Weight | Usage |
|-------|--------|--------|-------|
| `font-sans` | **DM Sans** | 300-700 | Body text, UI labels, descriptions |
| `font-mono` | **JetBrains Mono** | 400, 500 | Fingerprints, IDs, code, data labels, section tags |

**Section tags** (e.g., "THE PROTOCOL", "CORE INFRASTRUCTURE") use `font-mono` or `font-sans` at `text-xs font-semibold uppercase tracking-[0.2em] text-cyber-cyan`.

**Data values** (stat numbers, hex strings, timestamps) always use `font-mono`.

---

## Corners & Shapes

**Maximum border radius: 2px (`rounded-sm`).** This is the defining visual rule of the Precision Engine system.

| Element | Radius | Class |
|---------|--------|-------|
| Cards, panels | 2px | `rounded-sm` |
| Buttons | 2px | `rounded-sm` (via `.cyber-btn`) |
| Inputs | 2px | `rounded-sm` (via `.cyber-input`) |
| Icon containers | 2px | `rounded-sm` |
| FAQ items | 2px | `rounded-sm` |
| Team photos | Full circle | `rounded-full` (exception for headshots) |
| Floating dots | Full circle | `rounded-full` (decorative only) |

**Banned:** `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-3xl` on any structural element. These create the "AI cookie-cutter" look.

---

## Elevation & Depth

Depth via **tonal layering** and **ambient glows**, not drop shadows.

### Tonal Layers
1. **Base:** `cyber-bg` (`#0a0f14`)
2. **Section:** `cyber-bg-light` (`#0f1a22`)
3. **Card:** `cyber-bg-card` (`#0d1820`)

### Ambient Glows (replace shadows)
| Token | CSS | Usage |
|-------|-----|-------|
| `shadow-glow-sm` | `0 0 15px rgba(0,212,255,0.3)` | Buttons at rest |
| `shadow-glow-md` | `0 0 25px rgba(0,212,255,0.4)` | Hover states |
| `shadow-neon` | `0 0 10px rgba(0,212,255,0.3), 0 0 30px rgba(0,212,255,0.1)` | Active/focused elements |

### Ghost Borders
When a container needs a visible edge: `border border-cyber-cyan-border` (25% opacity cyan). On hover: `border-cyber-cyan/40`.

---

## CSS Classes (defined in marketing `src/index.css`)

| Class | Effect |
|-------|--------|
| `.bg-circuit` | Subtle grid pattern (40px squares, 3% opacity cyan lines) |
| `.bg-mesh-gradient` / `.bg-mesh-dark` | Layered radial gradients for atmospheric depth |
| `.bg-dot-pattern` | Dot grid (24px spacing, 8% opacity) |
| `.bg-subtle-dots` | Lighter dot grid (32px, 3% opacity) |
| `.cyber-btn` | Primary button — cyan gradient, sharp edges, outer glow |
| `.cyber-input` | Input field — dark bg, cyan focus border + glow |
| `.cyber-card` | Card — sharp edges, cyan border, neon hover glow |
| `.glass-card` / `.glass-dark` | Backdrop-blur containers |
| `.gradient-border` | Gradient border via CSS mask |
| `.section-divider` | Gradient horizontal rule (transparent → cyan → transparent) |
| `.animate-in-view` | Scroll-triggered fade-up (0.6s cubic-bezier) |
| `.animate-glow-pulse` | Pulsing glow animation (3s cycle) |
| `.timeline-glow-bar` | Vertical cyan bar for roadmap timeline |
| `.stagger-1` through `.stagger-6` | Animation delay utilities (60ms intervals) |

---

## Component Rules

### Cards (No-Box Approach)
- Border: `border-cyber-cyan-border` (25% opacity)
- Background: `bg-cyber-bg-card/60` with `backdrop-blur-sm`
- Radius: `rounded-sm` (2px) — **never rounded-2xl**
- Hover: `border-cyber-cyan/40` + `shadow-neon`
- No drop shadows at rest — ambient glow only on hover

### Buttons
- **Primary (`.cyber-btn`):** Cyan gradient (`from-cyber-cyan to-cyber-cyan-dim`), dark text (`text-cyber-bg`), outer glow, sharp edges
- **Ghost:** `border border-cyber-cyan-border`, transparent bg, cyan text, fills on hover

### Inputs
- Background: `bg-cyber-bg/80`
- Border: `border-cyber-cyan-border`
- Focus: cyan border + `box-shadow: 0 0 15px rgba(0,212,255,0.15)`

### Section Headers
- Tag: `font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cyber-cyan` (e.g., "THE PROTOCOL")
- Title: `text-3xl font-bold text-white md:text-4xl`
- Subtitle: `text-white/35` or `text-white/40`

### Icons
- Container: `h-12 w-12 rounded-sm bg-cyber-cyan/10 border border-cyber-cyan/20`
- Icon color: `text-cyber-cyan`
- Size: `h-6 w-6` standard, `h-7 w-7` for featured

### Team Photos
- Container: `h-28 w-28 rounded-full border border-cyber-cyan/20` (exception to sharp-edge rule)
- Image: `object-cover`

### Status Badges
- SECURED / ACTIVE: Green
- PENDING / SUBMITTED: Amber
- REVOKED: Red
- EXPIRED: Amber outline

### Data Display
- Fingerprints: `font-mono text-xs` in a dark code block
- IDs/hashes: `font-mono` always
- Timestamps: Regular font, formatted for locale

---

## Anti-Patterns (AVOID)

| Don't | Do Instead |
|-------|-----------|
| `rounded-2xl` on cards/buttons | `rounded-sm` (2px) everywhere |
| Pill badges ("Provable Verification") | Section tags in monospace |
| Floating shield/icon hero graphics | Full-width text hero, or asymmetric layout |
| Uniform card grids (3x equal boxes) | Varied layouts — numbered lists, data strips, asymmetric grids |
| `rounded-full` on icon containers | `rounded-sm` — square icons |
| Light mode toggle (dark-only design) | Commit to dark mode |
| 1px solid grey dividers | `.section-divider` (gradient fade) or background tonal shifts |
| Drop shadows | Ambient glows (`shadow-neon`, `shadow-glow-*`) |
| Inter, Roboto, Space Grotesk fonts | DM Sans + JetBrains Mono only |

---

## Migration Guide: App → Precision Engine

When updating `app.arkova.ai` to match:

1. **Tailwind config:** Add `cyber.*` color tokens alongside existing `arkova.*`
2. **CSS:** Port `.cyber-btn`, `.cyber-input`, `.cyber-card` classes to app's `index.css`
3. **Corners:** Global find/replace `rounded-2xl` → `rounded-sm`, `rounded-xl` → `rounded-sm`
4. **Buttons:** Replace `bg-arkova-steel` with `bg-cyber-cyan` gradient
5. **Backgrounds:** Dark sections use `bg-cyber-bg` / `bg-cyber-bg-light` instead of `bg-arkova-charcoal`
6. **Fonts:** Keep DM Sans + JetBrains Mono (already in use)
7. **Glows:** Replace `shadow-card-hover` with `shadow-neon`
8. **Test:** Verify all pages at 1280px + 375px (desktop + mobile)
