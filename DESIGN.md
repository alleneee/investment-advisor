---
name: Apex Ledger
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#bbcbb2'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#86957e'
  outline-variant: '#3d4b37'
  surface-tint: '#3ce42f'
  primary: '#3de530'
  on-primary: '#003a00'
  primary-container: '#00c805'
  on-primary-container: '#004c00'
  inverse-primary: '#006e01'
  secondary: '#ffb4aa'
  on-secondary: '#690003'
  secondary-container: '#c5020b'
  on-secondary-container: '#ffd2cc'
  tertiary: '#afc8ff'
  on-tertiary: '#002e69'
  tertiary-container: '#82acff'
  on-tertiary-container: '#003e87'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#77ff62'
  primary-fixed-dim: '#3ce42f'
  on-primary-fixed: '#002200'
  on-primary-fixed-variant: '#005300'
  secondary-fixed: '#ffdad5'
  secondary-fixed-dim: '#ffb4aa'
  on-secondary-fixed: '#410001'
  on-secondary-fixed-variant: '#930005'
  tertiary-fixed: '#d8e2ff'
  tertiary-fixed-dim: '#adc6ff'
  on-tertiary-fixed: '#001a41'
  on-tertiary-fixed-variant: '#004493'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
    letterSpacing: -0.01em
  label-caps:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 1px
---

## Brand & Style

The design system is engineered for high-stakes precision and rapid information processing. It targets professional traders who require a sophisticated, low-latency visual environment for technical analysis and post-trade reflection.

The style is **Professional / Modern** with a lean towards **High-Density Utility**. It prioritizes data integrity and legibility over decorative elements. By utilizing deep charcoal surfaces and high-contrast status colors, the system reduces eye strain during extended sessions while ensuring that critical market signals—entries, exits, and trend shifts—are immediately perceptible. The aesthetic is clinical, systematic, and authoritative, evoking a sense of institutional-grade control.

## Colors

The palette is anchored by a triple-black background strategy to manage depth in a high-density environment. 

- **Primary (Trading Green):** Reserved exclusively for bullish price action, profitable trade outcomes, and "Buy" actions.
- **Secondary (Trading Red):** Reserved for bearish price action, losses, and "Sell" actions.
- **Tertiary (Cyber Blue):** Used for technical indicators, active selections, and interactive UI elements that are price-neutral.
- **Neutral (Deep Charcoal):** Provides the structural foundation. Surfaces use subtle shifts in value rather than shadows to define hierarchy.

Avoid using primary or secondary colors for non-market data to prevent cognitive "false alarms."

## Typography

This design system utilizes **Inter** for all UI and narrative text to ensure maximum readability at small scales. **JetBrains Mono** is introduced for price data, tickers, and mathematical values to ensure tabular alignment and prevent "jumping" digits during live price updates.

- Use `data-mono` for all price feeds, P&L calculations, and timestamps.
- Use `label-caps` for table headers and section overviews to create clear visual anchors without consuming excessive vertical space.
- Keep line heights tight to support high information density, but ensure `body-md` remains legible for long-form journaling entries.

## Layout & Spacing

The layout follows a **Fluid Modular Grid** designed for multi-monitor setups. Modules are separated by a consistent 1px "ghost" gutter (using border-stroke) rather than wide gaps to maximize screen real estate for charts.

- **Desktop/Ultra-wide:** A 24-column grid allows for complex side-by-side technical analysis.
- **Density:** Use 8px (`sm`) padding inside data containers and 12px for journaling areas to provide a slightly more relaxed reading experience for notes.
- **Alignment:** All modules must snap to the 4px baseline grid to maintain vertical rhythm across disparate data types.

## Elevation & Depth

In a dark, high-density dashboard, traditional shadows are avoided to prevent visual "muddiness." Instead, depth is conveyed through **Tonal Layering** and **Low-Contrast Outlines**:

- **Level 0 (Base):** The main dashboard background (#0C0C0C).
- **Level 1 (Module):** Container surfaces (#121212) with a 1px border (#2C2C2C).
- **Level 2 (Interaction):** Hover states and active dropdowns use a lighter fill (#1E1E1E) and a subtle Cyber Blue glow or border to indicate focus.
- **Modals:** Use a solid 1px border of #3D3D3D and a 40% black backdrop blur to isolate critical trade confirmation tasks from the background noise.

## Shapes

The shape language is **Soft** but disciplined. 

- UI containers and modules use a 4px (`0.25rem`) radius to soften the technical edge without appearing "bubbly."
- Buttons and input fields mirror this 4px radius. 
- Interactive chips (e.g., watchlists) may use a fully rounded "pill" shape to distinguish them from structural data modules.
- Chart elements (candlesticks, bars) should remain sharp (0px radius) to ensure mathematical precision at the pixel level.

## Components

### Buttons
- **Primary Action (Buy):** Solid Trading Green with white or black text depending on accessibility contrast.
- **Secondary Action (Sell):** Solid Trading Red.
- **Ghost/Utility:** Cyber Blue 1px border with transparent fill for non-destructive actions (e.g., "Add Indicator").

### Input Fields
- Dark backgrounds (#0C0C0C) with 1px borders. Focus state triggers a 1px Cyber Blue border. 
- Numerical inputs must use `data-mono` font.

### Data Tables
- Row height: 32px (Compact) or 40px (Default).
- Alternating row zebra-striping is discouraged; use subtle 1px horizontal dividers instead.
- P&L columns must dynamically change text color (Green/Red) based on value.

### Journaling Area
- Uses a distinct vertical border to separate it from active trading modules. 
- Rich text support with a focus on bullet points and timestamped "Trade Logs."

### Interactive Charts
- Crosshair lines: 1px dashed Cyber Blue.
- Active price line: Solid label with background color matching the current price movement (Green/Red).