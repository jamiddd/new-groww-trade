import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { api, AppSettings, disconnect } from "@/src/api/client";
import { storage } from "@/src/utils/storage";
import { ColorPalette, FONT } from "@/src/theme";
import { ThemeMode, useTheme } from "@/src/theme/ThemeProvider";
import ConfirmSheet from "@/src/components/ConfirmSheet";

const ALWAYS_NEAREST_EXPIRY_KEY = "always_nearest_expiry";

export default function SettingsScreen() {
  const router = useRouter();
  const { Colors, mode: themeMode, setMode: setThemeMode } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);
  const [s, setS] = useState<AppSettings | null>(null);
  const [alwaysNearestExpiry, setAlwaysNearestExpiry] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [settings, nearestStored] = await Promise.all([
          api.settings(),
          storage.getItem<boolean>(ALWAYS_NEAREST_EXPIRY_KEY, false as boolean),
        ]);
        setS(settings);
        setAlwaysNearestExpiry(!!nearestStored);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const update = async (patch: Partial<AppSettings>) => {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    try {
      await api.updateSettings(next);
    } catch {
      // ignore optimistic-update errors
    }
  };

  const logout = async () => {
    await disconnect();
    router.replace("/login");
  };

  if (loading || !s) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={Colors.primary} style={{ marginTop: 32 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]} testID="settings-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="settings-back">
          <Text style={styles.headerBack}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>SETTINGS</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <SettingRow
          title="Confirm before executing orders"
          desc="Show a confirmation prompt before any order is placed."
          value={s.confirm_before_order}
          onChange={(v) => update({ confirm_before_order: v })}
          testID="setting-confirm"
        />
        <SettingRow
          title="Ask for daily max loss at startup"
          desc="Show the max-loss prompt when opening the app."
          value={s.ask_max_loss_at_startup}
          onChange={(v) => update({ ask_max_loss_at_startup: v })}
          testID="setting-max-loss"
        />
        <SettingRow
          title="Convert to live dollar value"
          desc="Display capital, balance and PnL in USD."
          value={s.convert_to_usd}
          onChange={(v) => update({ convert_to_usd: v })}
          testID="setting-usd"
        />
        <SettingRow
          title="Save last used underlying"
          desc="Remember the underlying & expiry across launches (when not expired)."
          value={s.save_last_underlying}
          onChange={(v) => update({ save_last_underlying: v })}
          testID="setting-save-underlying"
        />
        <SettingRow
          title="Always set next closest expiry"
          desc="Ignore the sticky expiry and auto-select the earliest upcoming expiry on launch and whenever you switch underlyings."
          value={alwaysNearestExpiry}
          onChange={async (v) => {
            setAlwaysNearestExpiry(v);
            await storage.setItem(ALWAYS_NEAREST_EXPIRY_KEY, v);
          }}
          testID="setting-always-nearest-expiry"
        />
        <SettingRow
          title="Practice mode"
          desc="Every BUY uses exactly 1 lot regardless of position sizing — minimal capital risk while you learn the flow."
          value={!!s.practice_mode}
          onChange={(v) => update({ practice_mode: v })}
          testID="setting-practice-mode"
        />

        {/* ───────── Appearance ───────── */}
        <Text style={styles.sectionLabel}>APPEARANCE</Text>
        <View style={styles.themeRow}>
          {(["light", "dark", "system"] as ThemeMode[]).map((m) => {
            const selected = themeMode === m;
            const label = m === "light" ? "Light" : m === "dark" ? "Dark" : "System";
            const emoji = m === "light" ? "☀️" : m === "dark" ? "🌙" : "📱";
            return (
              <TouchableOpacity
                key={m}
                style={[styles.themeOption, selected && styles.themeOptionActive]}
                onPress={() => setThemeMode(m)}
                testID={`setting-theme-${m}`}
                activeOpacity={0.85}
              >
                <Text style={[styles.themeEmoji]}>{emoji}</Text>
                <Text style={[styles.themeLabel, selected && styles.themeLabelActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={styles.appearanceHint}>
          OLED-black palette on dark. &quot;System&quot; follows your device setting.
        </Text>

        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={() => setConfirmLogout(true)}
          testID="settings-logout-button"
        >
          <Text style={styles.logoutText}>LOG OUT / DISCONNECT</Text>
        </TouchableOpacity>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <ConfirmSheet
        visible={confirmLogout}
        title="Disconnect from Groww?"
        message="You'll need to re-enter your API key and TOTP secret to reconnect."
        confirmLabel="DISCONNECT"
        destructive
        onConfirm={logout}
        onCancel={() => setConfirmLogout(false)}
        testID="confirm-logout"
      />
    </SafeAreaView>
  );
}

function SettingRow({
  title,
  desc,
  value,
  onChange,
  testID,
}: {
  title: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
  testID?: string;
}) {
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);
  return (
    <View style={styles.row} testID={testID}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.desc}>{desc}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: Colors.primary, false: Colors.border }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

const mkStyles = (Colors: ColorPalette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerBack: { fontFamily: FONT, color: Colors.text, fontSize: 20, fontWeight: "bold" },
  headerTitle: { fontFamily: FONT, color: Colors.text, fontWeight: "bold", fontSize: 14, letterSpacing: 1, flex: 1, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  title: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, fontSize: 14 },
  desc: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  logoutBtn: {
    marginTop: 32,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: Colors.danger,
    borderRadius: 10,
    alignItems: "center",
  },
  logoutText: { fontFamily: FONT, color: Colors.danger, fontWeight: "bold", letterSpacing: 1.2 },
  error: { fontFamily: FONT, color: Colors.dangerDark, textAlign: "center", marginTop: 16 },

  // Appearance section
  sectionLabel: {
    fontFamily: FONT,
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.4,
    marginTop: 24,
    marginBottom: 10,
  },
  themeRow: {
    flexDirection: "row",
    gap: 8,
  },
  themeOption: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    backgroundColor: Colors.pillBg,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  themeOptionActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.surfaceElevated,
  },
  themeEmoji: { fontSize: 22, marginBottom: 4 },
  themeLabel: {
    fontFamily: FONT,
    color: Colors.textSecondary,
    fontWeight: "600",
    fontSize: 13,
  },
  themeLabelActive: { color: Colors.primary, fontWeight: "700" },
  appearanceHint: {
    fontFamily: FONT,
    color: Colors.textMuted,
    fontSize: 11,
    marginTop: 8,
  },
});
