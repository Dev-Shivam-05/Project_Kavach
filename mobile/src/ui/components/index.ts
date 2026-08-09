/**
 * The component barrel.
 *
 * Screens import from here and never from a component file directly, so that a
 * primitive can be split or renamed without touching a screen. Nothing in this
 * directory reaches into `src/state` — these are dumb, testable, prop-driven
 * pieces; the store lives one layer up (ADR-018, the same seam the store keeps
 * with T0).
 *
 * `export *` deliberately does not carry default exports through: every
 * component is named, so a screen cannot accidentally bind the wrong one.
 *
 * Motion primitives live one level up in `src/ui/motion.ts`, not here — they are
 * hooks and constants rather than components, and the NO_MOTION guard that keeps
 * app/panic.tsx and app/probe.tsx compliant with PRD §6.4 has to be importable
 * without dragging the whole component barrel in behind it.
 */

// ── primitives ────────────────────────────────────────────────────────────────
export * from './PressableScale';
export * from './Button';
export * from './Card';
export * from './Section';
export * from './Pill';
export * from './StateBadge';
export * from './ListItem';
export * from './Toggle';
export * from './EmptyState';

// ── emergency & family surfaces ───────────────────────────────────────────────
export * from './CountdownRing';
export * from './MemberAvatar';
export * from './MemberRow';
export * from './BigCoordinates';
export * from './Call112Button';
export * from './Sparkline';
export * from './FamilyMapView';
