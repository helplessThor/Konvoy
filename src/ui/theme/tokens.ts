/**
 * Konvoy UI Design Tokens
 *
 * High-contrast, sunlight-readable design system for gloved motorcycle operation.
 * OLED-optimized dark mode with large touch targets (≥48dp).
 */

// ─── Colors ──────────────────────────────────────────────────────────────

export const Colors = {
  // Base
  background: '#0A0A0F',           // Near-black OLED
  surface: '#141420',              // Card/panel background
  surfaceElevated: '#1C1C2E',     // Elevated surface (modals, sheets)
  surfaceBorder: '#2A2A3E',       // Border on surfaces

  // Primary — Electric Orange (high visibility in sunlight)
  primary: '#FF6B2C',
  primaryLight: '#FF8A56',
  primaryDark: '#CC5020',
  primaryGlow: 'rgba(255, 107, 44, 0.25)',

  // Accent — Cyan (contrast against orange)
  accent: '#00E5FF',
  accentLight: '#66EEFF',
  accentDark: '#00B8CC',
  accentGlow: 'rgba(0, 229, 255, 0.2)',

  // Text
  textPrimary: '#F0F0F5',         // High-contrast white
  textSecondary: '#A0A0B8',       // Muted
  textInverse: '#0A0A0F',         // For use on primary buttons

  // Semantic
  success: '#4ADE80',             // Green — connection established
  warning: '#FBBF24',             // Amber — low battery, weak signal
  danger: '#EF4444',              // Red — disconnected, hazard
  info: '#60A5FA',                // Blue — informational

  // Hazard Pin Colors
  hazardPolice: '#4F7CFF',        // Blue
  hazardAccident: '#EF4444',      // Red
  hazardRoad: '#FBBF24',          // Amber
  hazardCongestion: '#FB923C',    // Orange

  // Map
  convoyMarker: '#FF6B2C',       // Own position
  peerMarker: '#00E5FF',         // Peer position
  routeLine: 'rgba(255, 107, 44, 0.6)',

  // Transparent
  overlay: 'rgba(10, 10, 15, 0.85)',
  scrim: 'rgba(0, 0, 0, 0.6)',
} as const;

// ─── Typography ──────────────────────────────────────────────────────────

export const Typography = {
  fontFamily: {
    regular: 'Inter-Regular',
    medium: 'Inter-Medium',
    semibold: 'Inter-SemiBold',
    bold: 'Inter-Bold',
    mono: 'JetBrainsMono-Regular',
  },
  size: {
    xs: 11,
    sm: 13,
    base: 15,
    md: 17,
    lg: 20,
    xl: 24,
    '2xl': 32,
    '3xl': 40,
    '4xl': 48,
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.75,
  },
} as const;

// ─── Spacing ─────────────────────────────────────────────────────────────

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 40,
  '4xl': 48,
  '5xl': 64,
} as const;

// ─── Touch Targets ───────────────────────────────────────────────────────
// Minimum 48dp for gloved operation

export const TouchTargets = {
  /** Minimum touch target for any interactive element */
  minimum: 48,
  /** Standard button height */
  button: 56,
  /** Large action button (e.g., PTT) */
  buttonLarge: 80,
  /** PTT circle button diameter */
  pttButton: 120,
  /** Icon button */
  iconButton: 48,
  /** List item height */
  listItem: 64,
  /** Tab bar height */
  tabBar: 64,
} as const;

// ─── Border Radius ───────────────────────────────────────────────────────

export const Radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

// ─── Shadows ─────────────────────────────────────────────────────────────

export const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 12,
  },
  glow: (color: string) => ({
    shadowColor: color,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 8,
  }),
} as const;

// ─── Animation ───────────────────────────────────────────────────────────

export const Animation = {
  duration: {
    fast: 150,
    normal: 250,
    slow: 400,
  },
  easing: {
    easeOut: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
    easeIn: 'cubic-bezier(0.4, 0.0, 1, 1)',
    easeInOut: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
  },
} as const;

// ─── Z-Index ─────────────────────────────────────────────────────────────

export const ZIndex = {
  base: 0,
  overlay: 10,
  modal: 20,
  tooltip: 30,
  pttButton: 50,  // PTT always on top
} as const;
