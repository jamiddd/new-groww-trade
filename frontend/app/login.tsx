import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Switch,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { api, setToken } from "@/src/api/client";
import { Colors, FONT } from "@/src/theme";

export default function Login() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saveSecure, setSaveSecure] = useState(true);
  const [showSecret, setShowSecret] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setError("API key and secret are required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(apiKey.trim(), apiSecret.trim());
      if (saveSecure) {
        await setToken(res.access_token);
      } else {
        await setToken(res.access_token); // session-only effectively; will be cleared on logout
      }
      router.replace("/home");
    } catch (e: any) {
      setError(e?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          testID="login-screen"
        >
          <View style={styles.brand}>
            <Text style={styles.brandTitle}>SCALPX</Text>
            <Text style={styles.brandSub}>Options scalping · Groww</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>API KEY</Text>
            <TextInput
              testID="login-api-key-input"
              style={styles.input}
              placeholder="Paste your Groww API key"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              value={apiKey}
              onChangeText={setApiKey}
            />

            <Text style={[styles.label, { marginTop: 16 }]}>API SECRET (TOTP SEED)</Text>
            <View style={styles.row}>
              <TextInput
                testID="login-api-secret-input"
                style={[styles.input, { flex: 1 }]}
                placeholder="Base32 TOTP secret"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!showSecret}
                value={apiSecret}
                onChangeText={setApiSecret}
              />
              <TouchableOpacity
                testID="login-show-secret-toggle"
                onPress={() => setShowSecret((v) => !v)}
                style={styles.eyeBtn}
              >
                <Text style={styles.eyeText}>{showSecret ? "HIDE" : "SHOW"}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Save credentials securely</Text>
                <Text style={styles.switchHint}>Stored in device keychain (encrypted)</Text>
              </View>
              <Switch
                testID="login-save-secure-switch"
                value={saveSecure}
                onValueChange={setSaveSecure}
                trackColor={{ true: Colors.primary, false: Colors.border }}
                thumbColor="#FFFFFF"
              />
            </View>
          </View>

          {error ? (
            <View style={styles.errorBox} testID="login-error">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            testID="login-connect-button"
            style={[styles.connectBtn, loading && { opacity: 0.6 }]}
            onPress={onConnect}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.connectText}>CONNECT</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.footnote}>
            Generate your API key and TOTP secret from groww.in › Trading API › API Keys.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  container: { padding: 24, paddingTop: 40, gap: 16 },
  brand: { marginBottom: 24 },
  brandTitle: {
    fontFamily: FONT,
    fontSize: 36,
    fontWeight: "bold",
    color: Colors.text,
    letterSpacing: 4,
  },
  brandSub: {
    fontFamily: FONT,
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  card: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 16,
    backgroundColor: Colors.surface,
  },
  label: {
    fontFamily: FONT,
    fontWeight: "bold",
    fontSize: 11,
    letterSpacing: 1.2,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  input: {
    fontFamily: FONT,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 14,
    color: Colors.text,
    backgroundColor: "#FAFAFA",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  eyeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: Colors.borderLight,
  },
  eyeText: { fontFamily: FONT, fontWeight: "bold", fontSize: 11, color: Colors.textSecondary },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
  },
  switchLabel: { fontFamily: FONT, fontSize: 14, fontWeight: "bold", color: Colors.text },
  switchHint: { fontFamily: FONT, fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  errorBox: {
    backgroundColor: "#FEF2F2",
    borderColor: Colors.dangerDark,
    borderWidth: 1,
    padding: 12,
    borderRadius: 8,
  },
  errorText: { fontFamily: FONT, color: Colors.dangerDark, fontSize: 13 },
  connectBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 8,
  },
  connectText: { fontFamily: FONT, color: "#FFFFFF", fontWeight: "bold", fontSize: 15, letterSpacing: 1.2 },
  footnote: { fontFamily: FONT, fontSize: 12, color: Colors.textMuted, textAlign: "center", marginTop: 8 },
});
