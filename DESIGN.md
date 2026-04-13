# Design System — 城市浪人

## Product Context
- **What this is:** 台灣衝浪預報 PWA，提供 AI 浪況分析與即時預報
- **Who it's for:** 台灣本地衝浪者，早上半睡半醒時查看今天要不要出門衝浪
- **Space/industry:** Surf forecast (Surfline, Magic Seaweed, Windy)
- **Project type:** Mobile-first PWA, utility app with AI chat

## Aesthetic Direction
- **Direction:** Organic/Natural
- **Decoration level:** Intentional (subtle warmth, not sterile)
- **Mood:** 像早上在海邊的感覺。溫暖、親切、有活力。像會衝浪的朋友，不是氣象儀器。
- **Differentiators:** Warm sand background (competitors all use cold white/blue), sunrise gold accent, Outfit display font (competitors all use system fonts)

## Typography
- **Display/Hero:** Outfit (700-800) — geometric but friendly, gives headings identity without fighting CJK text
- **Body:** DM Sans (400-600) — excellent readability, clean geometric forms, supports tabular-nums
- **UI/Labels:** DM Sans (700, uppercase for metric labels)
- **Data/Tables:** DM Sans (700, tabular-nums) — numbers align in columns
- **CJK Fallback:** Noto Sans TC (400, 500, 700) — ensures Chinese text is always clear
- **Code:** JetBrains Mono (if ever needed)
- **Loading:** Google Fonts CDN
  ```html
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@700;800&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
  ```
- **Font stack:**
  ```css
  --font-display: 'Outfit', 'Noto Sans TC', sans-serif;
  --font-body: 'DM Sans', 'Noto Sans TC', -apple-system, 'PingFang TC', sans-serif;
  ```
- **Scale (modular, ~1.25 ratio):**
  | Token | Size | Use |
  |-------|------|-----|
  | text-xs | 0.68rem (11px) | Sub-labels, metadata |
  | text-sm | 0.82rem (13px) | Secondary text, captions |
  | text-base | 0.88rem (14px) | Body text, UI labels |
  | text-md | 1rem (16px) | Prominent body, card titles |
  | text-lg | 1.25rem (20px) | Section headings |
  | text-xl | 1.5rem (24px) | Page titles (H1) |
  | text-2xl | 2rem (32px) | Hero (about page) |

## Color
- **Approach:** Balanced — ocean blue primary, sunrise gold accent, warm neutrals
- **CSS Variables:**
  ```css
  :root {
    --ocean:      #0077b6;  /* Primary — brand, links, CTAs */
    --sky:        #00b4d8;  /* Header gradient end */
    --gold:       #f59e0b;  /* Accent — ratings, highlights, excitement */
    --gold-light: #fef3c7;  /* Gold tint for backgrounds */
    --sand:       #f5f0eb;  /* Page background (warm, not cold white) */
    --sand-dark:  #e8e0d8;  /* Borders on sand background */
    --card-bg:    #ffffff;  /* Card surfaces */
    --text:       #1a1a2e;  /* Primary text */
    --muted:      #6b7280;  /* Secondary text */
    --good:       #16a34a;  /* Success, good conditions */
    --ok:         #d97706;  /* Warning, mediocre conditions */
    --bad:        #dc2626;  /* Error, poor conditions */
  }
  ```
- **Dark mode:**
  ```css
  @media (prefers-color-scheme: dark) {
    :root {
      --sand:      #0f172a;  /* Deep sea background */
      --sand-dark: #1e293b;  /* Elevated surface */
      --card-bg:   #1e293b;  /* Card surfaces */
      --text:      #f1f5f9;  /* Off-white text (not pure white) */
      --muted:     #94a3b8;  /* Muted text */
      --ocean:     #38bdf8;  /* Desaturated +10% for dark bg */
      --gold:      #fbbf24;  /* Slightly lighter gold */
    }
  }
  ```
- **Semantic colors:** Confidence badges use green (#dcfce7/#166534), amber (#fef3c7/#854d0e), red (#fee2e2/#991b1b) with dark mode inversions

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable
- **Scale:**
  | Token | Value | Common use |
  |-------|-------|------------|
  | 2xs | 2px | Tight gaps (inline elements) |
  | xs | 4px | Icon-text gap, tight margin |
  | sm | 8px | Card internal gaps |
  | md | 16px | Section gaps, card padding |
  | lg | 24px | Section separators |
  | xl | 32px | Major section breaks |
  | 2xl | 48px | Page-level padding |
  | 3xl | 64px | Hero spacing |

## Layout
- **Approach:** Grid-disciplined (utility app, not editorial)
- **Max content width:** 760px
- **Grid:** Single column on mobile, `repeat(auto-fill, minmax(300px, 1fr))` for spot cards
- **Border radius:**
  | Token | Value | Use |
  |-------|-------|-----|
  | sm | 4px | Subtle rounding (metric boxes inner) |
  | md | 8px | Inputs, buttons, metric cards |
  | lg | 12px | Cards, sections, modals |
  | full | 9999px | Pills, badges, avatar |
- **Safe area:** Always use `env(safe-area-inset-*)` for PWA edge-to-edge

## Motion
- **Approach:** Minimal-functional
- **Easing:** enter(ease-out), exit(ease-in), move(ease-in-out)
- **Duration:** micro(50-100ms), short(150-250ms), medium(250-400ms)
- **Rules:**
  - Only animate `transform` and `opacity` (never layout properties)
  - Always respect `prefers-reduced-motion: reduce`
  - Card expand/collapse: 150ms ease-out
  - Button hover/active: 100ms
  - No decorative animations, no entrance animations, no scroll-driven effects

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-13 | Initial design system | Created by /design-consultation. Competitive research: all surf apps use system fonts + cold blue. Our differentiator: warm sand bg, Outfit display font, sunrise gold accent. |
| 2026-04-13 | Warm sand background #f5f0eb | Competitors all use cold white/blue. Sand gives "at the beach" feel, not "weather station." |
| 2026-04-13 | Outfit for display, DM Sans for body | System fonts are functional but generic. Outfit adds identity to headings (~25KB cost). DM Sans for body/data is highly readable with tabular-nums. |
| 2026-04-13 | Sunrise gold #f59e0b as accent | Rating stars and highlights in warm gold instead of cold color. Makes "good waves" feel exciting. |
