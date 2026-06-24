import { useEffect, useState } from "react";
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
import { Colors, FONT } from "@/src/theme";
import ConfirmSheet from "@/src/components/ConfirmSheet";

export default function SettingsScreen() {
  const router = useRouter();
  const [s, setS] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setS(await api.settings());
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
          title="Practice mode"
          desc="Every BUY uses exactly 1 lot regardless of position sizing — minimal capital risk while you learn the flow."
          value={!!s.practice_mode}
          onChange={(v) => update({ practice_mode: v })}
          testID="setting-practice-mode"
        />

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

const styles = StyleSheet.create({
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
});
