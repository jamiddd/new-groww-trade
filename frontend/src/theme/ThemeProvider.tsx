import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";

import { ColorPalette, DarkColors, LightColors } from "@/src/theme";
import { storage } from "@/src/utils/storage";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedScheme = "light" | "dark";

type ThemeContextValue = {
  /** What the user picked: 'light' | 'dark' | 'system'. */
  mode: ThemeMode;
  /** The currently-applied palette after resolving 'system' against the device. */
  scheme: ResolvedScheme;
  /** Active palette (already resolved). */
  Colors: ColorPalette;
  /** Setter — persists to AsyncStorage. */
  setMode: (m: ThemeMode) => Promise<void>;
};

const STORAGE_KEY = "theme_mode";

const noopAsync = async () => {};

const ThemeContext = createContext<ThemeContextValue>({
  mode: "system",
  scheme: "light",
  Colors: LightColors,
  setMode: noopAsync,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme() === "dark" ? "dark" : "light";
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [loaded, setLoaded] = useState(false);

  // Hydrate persisted mode once on mount.
  useEffect(() => {
    (async () => {
      try {
        const saved = await storage.getItem<ThemeMode>(STORAGE_KEY, "system" as ThemeMode);
        if (saved === "light" || saved === "dark" || saved === "system") {
          setModeState(saved);
        }
      } catch {}
      setLoaded(true);
    })();
  }, []);

  const setMode = useCallback(async (m: ThemeMode) => {
    setModeState(m);
    try {
      await storage.setItem(STORAGE_KEY, m);
    } catch {}
  }, []);

  const scheme: ResolvedScheme = mode === "system" ? systemScheme : mode;
  const Colors = scheme === "dark" ? DarkColors : LightColors;

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, scheme, Colors, setMode }),
    [mode, scheme, Colors, setMode],
  );

  // Avoid a flash of light theme during the storage hydration tick.
  if (!loaded) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Hook returning the active palette + setters. Consumers should:
 *
 *   const { Colors } = useTheme();
 *   const styles = useMemo(() => mkStyles(Colors), [Colors]);
 *
 * (the `mkStyles` factory pattern lets us keep StyleSheet.create() while
 * still reacting to palette changes — much cheaper than reading colors
 * inline in JSX, and avoids React re-creating the StyleSheet every render.)
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Convenience hook when you only need the palette. */
export function useColors(): ColorPalette {
  return useContext(ThemeContext).Colors;
}
