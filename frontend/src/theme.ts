import { Platform } from "react-native";

/**
 * Color palette derived from /app/design_guidelines.json.
 *
 * Two themed palettes ship with the app: a clean Light palette (default,
 * matches the original product spec) and an OLED-black Dark palette
 * tuned for AMOLED displays. They share identical keys so screens can
 * swap palette at runtime without touching their layout code.
 */

export type ColorPalette = {
  bg: string;
  surface: string;
  surfaceElevated: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  primaryDark: string;
  danger: string;
  dangerDark: string;
  pnlPositive: string;
  pnlNegative: string;
  borderLight: string;
  border: string;
  borderDark: string;
  pillBg: string;
};

export const LightColors: ColorPalette = {
  bg: "#FFFFFF",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  text: "#000000",
  textSecondary: "#6B7280",
  textMuted: "#9CA3AF",
  primary: "#1A4DFF",
  primaryDark: "#0F1F4D",
  danger: "#EF4444",
  dangerDark: "#B91C1C",
  pnlPositive: "#1A4DFF",
  pnlNegative: "#B91C1C",
  borderLight: "#F3F4F6",
  border: "#E5E7EB",
  borderDark: "#9CA3AF",
  pillBg: "#F3F4F6",
};

// OLED-black: pure black background so individual pixels stay off on
// AMOLED panels (saves battery + true infinite contrast). Surfaces are
// barely-lifted greys so cards still read as "elevated".
export const DarkColors: ColorPalette = {
  bg: "#000000",
  surface: "#0A0A0A",
  surfaceElevated: "#141414",
  text: "#F3F4F6",
  textSecondary: "#9CA3AF",
  textMuted: "#6B7280",
  primary: "#4F8AFF",
  primaryDark: "#1A4DFF",
  danger: "#F87171",
  dangerDark: "#DC2626",
  pnlPositive: "#4F8AFF",
  pnlNegative: "#F87171",
  borderLight: "#1F2937",
  border: "#27272A",
  borderDark: "#52525B",
  pillBg: "#18181B",
};

/**
 * Back-compat export. Top-level code (e.g. an `import { Colors } …`
 * that hasn't been migrated to `useTheme()` yet) still gets a sensible
 * default — the Light palette — so the app never crashes from a stale
 * import.
 */
export const Colors = LightColors;

// Device-native typography: SF on iOS, Roboto on Android, system default on web.
export const FONT = Platform.select({ ios: "System", android: "Roboto", default: undefined }) as string | undefined;

export const fontStyle = (weight: "normal" | "bold" = "normal") => ({
  fontFamily: FONT,
  fontWeight: weight as any,
});
