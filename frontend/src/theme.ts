import { Platform } from "react-native";

/**
 * Color palette derived from /app/design_guidelines.json
 */
export const Colors = {
  bg: "#FFFFFF",
  surface: "#FFFFFF",
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

// Device-native typography: SF on iOS, Roboto on Android, system default on web.
export const FONT = Platform.select({ ios: "System", android: "Roboto", default: undefined }) as string | undefined;

export const fontStyle = (weight: "normal" | "bold" = "normal") => ({
  fontFamily: FONT,
  fontWeight: weight as any,
});
