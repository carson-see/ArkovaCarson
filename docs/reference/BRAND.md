# Nordic Vault Design System
_Extracted from CLAUDE.md Section 5 — 2026-03-17 | Established PR #42_

## Brand Colors

| Name | Hex | HSL | Usage |
|------|-----|-----|-------|
| Steel Blue | `#82b8d0` | 197 42% 66% | Primary / buttons / links |
| Charcoal | `#303433` | 156 4% 19% | Sidebar background / foreground |
| Ice Blue | `#dbeaf1` | 199 44% 90% | Secondary / light backgrounds |

## Typography (Locked)

| Token | Family | Source | Usage |
|-------|--------|--------|-------|
| `font-sans` | **DM Sans** (300-700) | Google Fonts, `index.html` | Headings, body text, UI labels |
| `font-mono` | **JetBrains Mono** (400, 500) | Google Fonts, `index.html` | Fingerprints, IDs, code blocks |

**Banned fonts:** Inter, Roboto, Arial, Space Grotesk, system-ui default stack. Never revert to these.

## CSS Custom Properties

The `:root` and `.dark` blocks in `src/index.css` define all theme tokens. The Arkova palette is already applied (Steel Blue as primary, Charcoal as sidebar). See `tailwind.config.ts` for the `arkova.*` color scale. Extended vars: `--glow-primary`, `--glow-success`, `--surface-elevated`.

## Atmospheric CSS Classes (defined in `src/index.css`)

| Class | Effect |
|-------|--------|
| `.bg-mesh-gradient` | Layered radial gradients for atmospheric content backgrounds |
| `.bg-dot-pattern` | Subtle dot grid pattern overlay (24px spacing) |
| `.glass-card` | Frosted glass (backdrop-filter blur 16px + transparency) |
| `.glass-header` | Glassmorphism header (blur 12px + saturate 1.5) |
| `.gradient-border` | Gradient border via CSS mask technique |
| `.glow-primary` / `.glow-success` | Colored glow box-shadows |
| `.nav-glow` | Active sidebar nav item glow bar (3px left) |
| `.sidebar-gradient` | Dark gradient for sidebar background |
| `.shimmer` | Animated loading state shimmer gradient |
| `.animate-in-view` | Staggered reveal-up animation (0.5s cubic-bezier) |
| `.animate-float` / `.animate-float-delayed` / `.animate-float-slow` | Floating decoration keyframes (6-8s) |
| `.stagger-1` through `.stagger-8` | Animation-delay utilities (60ms intervals) |

## Tailwind Shadows (defined in `tailwind.config.ts`)

| Token | Usage |
|-------|-------|
| `shadow-glow-sm/md/lg` | Primary-colored glow shadows (increasing intensity) |
| `shadow-card-hover` | Elevated hover state for cards |
| `shadow-card-rest` | Subtle rest state for cards |

## Brand Rules for New Components

When creating ANY new frontend component, follow these rules:

1. **Cards:** Use `shadow-card-rest` at rest, `shadow-card-hover` on hover with `hover:-translate-y-0.5`
2. **Page entry:** Use `animate-in-view` with `stagger-N` for staggered reveal animations
3. **Loading:** Use `shimmer` class for loading skeletons (NOT `Skeleton` component)
4. **Icon containers:** `rounded-xl` with gradient backgrounds (`bg-gradient-to-br from-primary/15 to-primary/5`)
5. **Labels:** Uppercase with tracking: `text-xs font-medium uppercase tracking-wide`
6. **Emphasis buttons:** `shadow-glow-sm hover:shadow-glow-md`
7. **Code/IDs:** `font-mono` (JetBrains Mono) for fingerprints, IDs, code
8. **Never revert** to Inter, Roboto, or system fonts
9. **Sidebar:** `sidebar-gradient` class, `nav-glow` on active items
10. **Header:** `glass-header` (backdrop blur), slim `h-14`
11. **Auth pages:** `bg-mesh-gradient` + `bg-dot-pattern` overlay + floating orbs + `gradient-border` card
12. **Status badges:** SECURED=green, PENDING=amber, REVOKED=red (destructive), EXPIRED=amber (outline)
13. **Fingerprint display:** `font-mono text-xs bg-muted rounded px-2 py-1`
14. **Logo:** White wordmark + light blue bear on dark backgrounds; full-color on white

## Frontend Aesthetics Anti-Patterns (AVOID)

- Overused font families (Inter, Roboto, Arial, system fonts, Space Grotesk)
- Cliche color schemes (purple gradients on white backgrounds)
- Predictable layouts and cookie-cutter component patterns
- Flat solid-color backgrounds (use mesh gradients, dot patterns, atmospheric depth)
- Generic loading states (use shimmer, not basic skeleton rectangles)
- Missing motion (every page should have orchestrated entry animations)
