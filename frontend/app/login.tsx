import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";

import { api, setToken } from "@/src/api/client";
import { storage } from "@/src/utils/storage";
import { ColorPalette, FONT } from "@/src/theme";
import { useTheme } from "@/src/theme/ThemeProvider";
import BottomSheet from "@/src/components/BottomSheet";

type SavedProfile = {
  id: string;
  name: string;
  key_preview: string;
  mode: "passphrase" | "device";
  created_at: string;
};

const DEVICE_TOKEN_KEY = "device_token";

async function getOrCreateDeviceToken(): Promise<string> {
  let t = await storage.secureGet<string>(DEVICE_TOKEN_KEY, "" as string);
  if (!t) {
    const buf = new Uint8Array(32);
    if (typeof crypto !== "undefined" && (crypto as any).getRandomValues) {
      (crypto as any).getRandomValues(buf);
    } else {
      for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    t = btoa(String.fromCharCode(...buf)).replace(/=+$/, "");
    await storage.secureSet(DEVICE_TOKEN_KEY, t);
  }
  return t!;
}

export default function Login() {
  const router = useRouter();
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);

  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [profileName, setProfileName] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saveWithPassphrase, setSaveWithPassphrase] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);

  const [profiles, setProfiles] = useState<SavedProfile[]>([]);
  // The IP that needs to be whitelisted in Groww's Trading API console.
  // Priority order:
  //   1. EXPO_PUBLIC_GROWW_WHITELIST_IP — explicit override, set in .env.
  //      This is the one we trust because it's the actual outbound IP
  //      that hits Groww's servers (the droplet that places orders).
  //   2. EXPO_PUBLIC_BACKEND_URL host, if it's an IPv4 literal.
  //   3. The live /api/auth/server-ip endpoint — last resort, only used
  //      when neither override is set. (Otherwise we'd risk overwriting
  //      the correct droplet IP with whatever upstream egress IP the
  //      backend's outbound request to api.ipify.org happens to hit.)
  const defaultIp = (() => {
    const explicit = process.env.EXPO_PUBLIC_GROWW_WHITELIST_IP?.trim();
    if (explicit && /^\d+\.\d+\.\d+\.\d+$/.test(explicit)) return explicit;
    try {
      const raw = process.env.EXPO_PUBLIC_BACKEND_URL ?? "";
      const host = new URL(raw).hostname;
      return /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : null;
    } catch {
      return null;
    }
  })();
  const [serverIp, setServerIp] = useState<string | null>(defaultIp);
  const [ipCopied, setIpCopied] = useState(false);

  // Host of EXPO_PUBLIC_BACKEND_URL — every API call (including order
  // placement) goes through this. We surface it on the login screen so
  // the user can immediately see whether their build is talking to the
  // whitelisted droplet or, say, the preview pod (which would cause
  // Groww to reject orders with "Request from unregistered IP").
  const { backendHost, backendMatchesWhitelist } = useMemo(() => {
    let host = "";
    try {
      host = new URL(process.env.EXPO_PUBLIC_BACKEND_URL ?? "").host || "(unset)";
    } catch {
      host = "(unset)";
    }
    const whitelistIp = process.env.EXPO_PUBLIC_GROWW_WHITELIST_IP?.trim() ?? "";
    const matches = whitelistIp ? host.startsWith(whitelistIp) : true;
    return { backendHost: host, backendMatchesWhitelist: matches };
  }, []);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Passphrase prompt
  const [unlockProfile, setUnlockProfile] = useState<SavedProfile | null>(null);
  const [passphraseInput, setPassphraseInput] = useState("");
  const [savePassphrase, setSavePassphrase] = useState("");
  const [showSavePassphrase, setShowSavePassphrase] = useState(false);
  const [saveProfileVisible, setSaveProfileVisible] = useState(false);

  const refreshProfiles = useCallback(async () => {
    try {
      const res = await api.listProfiles();
      setProfiles(res.items);
    } catch {
      setProfiles([]);
    }
  }, []);

  useEffect(() => {
    refreshProfiles();
    // Only fall back to /api/auth/server-ip when EXPO_PUBLIC_BACKEND_URL
    // didn't already give us a literal IP — otherwise we'd risk
    // overwriting the correct droplet IP with whatever upstream egress IP
    // the backend's outbound request to api.ipify.org hits.
    if (!defaultIp) {
      api.serverIp().then((r) => setServerIp(r.ip)).catch(() => setServerIp(null));
    }
    // Attempt auto-login from device-token profile
    (async () => {
      const lastId = await storage.getItem<string>("auto_login_profile_id", "" as string);
      if (lastId) {
        try {
          const tok = await getOrCreateDeviceToken();
          const res = await api.unlockProfile(lastId, { device_token: tok });
          await setToken(res.access_token);
          router.replace("/home");
        } catch {
          // silent; user can re-auth manually
        }
      }
    })();
  }, [refreshProfiles, router, defaultIp]);

  const onConnect = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setError("API key and secret are required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(apiKey.trim(), apiSecret.trim());
      await setToken(res.access_token);

      // Persist the credentials according to the saved-creds settings
      if (saveWithPassphrase || autoLogin) {
        setSaveProfileVisible(true);
        // We don't navigate yet; user provides the passphrase / confirms.
      } else {
        router.replace("/home");
      }
    } catch (e: any) {
      setError(e?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const finalizeSaveAndContinue = async () => {
    setError(null);
    try {
      const name = profileName.trim() || "My Account";
      if (saveWithPassphrase) {
        if (!savePassphrase || savePassphrase.length < 4) {
          setError("Passphrase must be at least 4 characters");
          return;
        }
        await api.saveProfile({ name, api_key: apiKey.trim(), api_secret: apiSecret.trim(), passphrase: savePassphrase });
      }
      if (autoLogin) {
        const tok = await getOrCreateDeviceToken();
        const saved = await api.saveProfile({ name: name + " (this device)", api_key: apiKey.trim(), api_secret: apiSecret.trim(), device_token: tok });
        await storage.setItem("auto_login_profile_id", saved.id);
      }
      setSaveProfileVisible(false);
      router.replace("/home");
    } catch (e: any) {
      setError(e?.message ?? "Failed to save profile");
    }
  };

  const onPickProfile = (p: SavedProfile) => {
    if (p.mode === "device") {
      (async () => {
        try {
          const tok = await getOrCreateDeviceToken();
          const res = await api.unlockProfile(p.id, { device_token: tok });
          await setToken(res.access_token);
          await storage.setItem("auto_login_profile_id", p.id);
          router.replace("/home");
        } catch (e: any) {
          setError(e?.message ?? "Auto-unlock failed");
        }
      })();
      return;
    }
    setUnlockProfile(p);
    setPassphraseInput("");
  };

  const doUnlock = async () => {
    if (!unlockProfile) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.unlockProfile(unlockProfile.id, { passphrase: passphraseInput });
      await setToken(res.access_token);
      setUnlockProfile(null);
      router.replace("/home");
    } catch (e: any) {
      setError(e?.message ?? "Wrong passphrase");
    } finally {
      setLoading(false);
    }
  };

  const onDeleteProfile = async (p: SavedProfile) => {
    try {
      await api.deleteProfile(p.id);
      if (p.mode === "device") {
        await storage.removeItem("auto_login_profile_id");
      }
      await refreshProfiles();
    } catch (e: any) {
      setError(e?.message ?? "Delete failed");
    }
  };

  const copyIp = async () => {
    if (!serverIp) return;
    await Clipboard.setStringAsync(serverIp);
    setIpCopied(true);
    setTimeout(() => setIpCopied(false), 1500);
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
          {/* Logo + heading */}
          <View style={styles.brandRow}>
            <View style={styles.logoBadge} testID="brand-logo">
              <Feather name="trending-up" size={32} color="#FFFFFF" />
            </View>
          </View>
          <Text style={styles.title}>Connect Groww</Text>
          <Text style={styles.subtitle}>
            Trade Indian equities, F&O and commodities via the Groww Trading API.
          </Text>

          {/* Saved profiles */}
          {profiles.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>SAVED PROFILES</Text>
              {profiles.map((p) => (
                <View key={p.id} style={styles.profileCard} testID={`profile-row-${p.id}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.profileName}>{p.name}</Text>
                    <Text style={styles.profileMeta}>
                      Key {p.key_preview} <Text style={styles.dotSep}>·</Text>{" "}
                      <Text>{p.mode === "passphrase" ? "passphrase" : "auto-login"}</Text>
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.unlockBtn}
                    onPress={() => onPickProfile(p)}
                    testID={`profile-unlock-${p.id}`}
                  >
                    <Feather name={p.mode === "passphrase" ? "key" : "smartphone"} size={14} color={Colors.text} />
                    <Text style={styles.unlockText}>
                      {p.mode === "passphrase" ? "Passphrase" : "Unlock"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.trashBtn}
                    onPress={() => onDeleteProfile(p)}
                    testID={`profile-delete-${p.id}`}
                  >
                    <Feather name="trash-2" size={16} color={Colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>Or connect with new credentials below</Text>
                <View style={styles.dividerLine} />
              </View>
            </View>
          ) : null}

          {/* API Key */}
          <View style={styles.fieldGroup}>
            <View style={styles.fieldLabelRow}>
              <Feather name="key" size={14} color={Colors.text} />
              <Text style={styles.fieldLabel}>API Key</Text>
            </View>
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
          </View>

          {/* API Secret */}
          <View style={styles.fieldGroup}>
            <View style={styles.fieldLabelRow}>
              <Feather name="lock" size={14} color={Colors.text} />
              <Text style={styles.fieldLabel}>API Secret</Text>
            </View>
            <View style={styles.inputWithIcon}>
              <TextInput
                testID="login-api-secret-input"
                style={[styles.input, { flex: 1, borderWidth: 0, paddingRight: 36 }]}
                placeholder="Paste your Groww API secret"
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
                style={styles.eyeIconBtn}
              >
                <Feather name={showSecret ? "eye-off" : "eye"} size={16} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Save Credentials box */}
          <View style={styles.saveBox}>
            <View style={styles.saveBoxHeader}>
              <Feather name="save" size={14} color={Colors.text} />
              <Text style={styles.saveBoxTitle}>SAVE CREDENTIALS</Text>
            </View>

            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleTitle}>Save with passphrase</Text>
                <Text style={styles.toggleDesc}>
                  Encrypted on server. Enter the passphrase to reconnect.
                </Text>
              </View>
              <Switch
                testID="save-passphrase-switch"
                value={saveWithPassphrase}
                onValueChange={setSaveWithPassphrase}
                trackColor={{ true: Colors.primary, false: Colors.border }}
                thumbColor="#FFFFFF"
              />
            </View>

            <View style={[styles.toggleRow, { marginTop: 12 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleTitle}>Auto-login on this device</Text>
                <Text style={styles.toggleDesc}>
                  Zero-friction reconnect. Anyone with this browser can unlock.
                </Text>
              </View>
              <Switch
                testID="auto-login-switch"
                value={autoLogin}
                onValueChange={setAutoLogin}
                trackColor={{ true: Colors.primary, false: Colors.border }}
                thumbColor="#FFFFFF"
              />
            </View>
          </View>

          {/* Error */}
          {error ? (
            <View style={styles.errorBox} testID="login-error">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Connect CTA */}
          <TouchableOpacity
            testID="login-connect-button"
            style={[styles.connectBtn, loading && { opacity: 0.6 }]}
            onPress={onConnect}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.connectText}>Connect to Groww</Text>
            )}
          </TouchableOpacity>

          {/* Info box */}
          <View style={styles.infoBox}>
            <Feather name="shield" size={16} color={Colors.infoIcon} style={{ marginTop: 2 }} />
            <Text style={styles.infoText}>
              <Text style={{ fontWeight: "bold" }}>The API Key + Secret flow</Text> needs daily approval on Groww{"\u2019"}s Cloud API Keys page. You also need an active Trading API subscription. Saved credentials are encrypted at rest with a server-side pepper plus your passphrase / device token — the server cannot decrypt them on its own.
            </Text>
          </View>

          {/* IP whitelist warning */}
          <View style={styles.warnBox}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Feather name="server" size={16} color={Colors.warnIcon} style={{ marginTop: 2 }} />
              <Text style={styles.warnText}>
                <Text style={{ fontWeight: "bold" }}>Required for live orders</Text>: whitelist this server{"\u2019"}s IP under <Text style={{ fontStyle: "italic" }}>groww.in → Profile → Trading API → IP Restrictions.</Text> Login & quotes work without it, but order placement is rejected if the IP isn{"\u2019"}t registered.
              </Text>
            </View>
            <TouchableOpacity onPress={copyIp} style={styles.ipChip} testID="server-ip-copy">
              <Text style={styles.ipText}>{serverIp ?? "—"}</Text>
              <Feather name={ipCopied ? "check" : "copy"} size={14} color={Colors.warnIcon} />
            </TouchableOpacity>
          </View>

          {/* Backend visibility — this is the host every order placement
              will fly through. If it doesn't match the IP above, your
              orders will hit Groww from a different (unwhitelisted) IP. */}
          <View style={styles.backendChip} testID="backend-host-chip">
            <Feather name="globe" size={12} color={Colors.textSecondary} />
            <Text style={styles.backendChipLabel}>API:</Text>
            <Text style={styles.backendChipValue}>{backendHost}</Text>
            {!backendMatchesWhitelist ? (
              <Text style={styles.backendChipWarn}>
                ⚠ doesn{"\u2019"}t match whitelist IP — orders may be rejected
              </Text>
            ) : null}
          </View>

          {/* Footer tip */}
          <Text style={styles.footnote}>
            Tip: try <Text style={styles.kbd}>demo</Text> / <Text style={styles.kbd}>demo</Text> to explore the UI without a real account.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Passphrase unlock modal */}
      <BottomSheet
        visible={!!unlockProfile}
        onClose={() => setUnlockProfile(null)}
        avoidKeyboard
        testID="passphrase-sheet"
      >
        <Text style={styles.sheetTitle}>Unlock {unlockProfile?.name}</Text>
        <Text style={styles.sheetSub}>Enter the passphrase you set when saving this profile.</Text>
        <TextInput
          style={styles.input}
          value={passphraseInput}
          onChangeText={setPassphraseInput}
          secureTextEntry
          autoFocus
          placeholder="Passphrase"
          placeholderTextColor={Colors.textMuted}
          testID="passphrase-input"
        />
        <TouchableOpacity style={styles.sheetCta} onPress={doUnlock} testID="passphrase-submit">
          <Text style={styles.sheetCtaText}>{loading ? "Unlocking…" : "UNLOCK & CONNECT"}</Text>
        </TouchableOpacity>
      </BottomSheet>

      {/* Save profile modal */}
      <BottomSheet
        visible={saveProfileVisible}
        onClose={() => setSaveProfileVisible(false)}
        avoidKeyboard
        testID="save-profile-sheet"
      >
        <Text style={styles.sheetTitle}>Save this profile</Text>
        <Text style={styles.sheetSub}>Give it a name and (if needed) a passphrase.</Text>
        <TextInput
          style={styles.input}
          value={profileName}
          onChangeText={setProfileName}
          placeholder="Profile name (e.g., Pixel)"
          placeholderTextColor={Colors.textMuted}
          testID="profile-name-input"
        />
        {saveWithPassphrase ? (
          <View style={[styles.inputWithIcon, { marginTop: 12 }]}>
            <TextInput
              style={[styles.input, { flex: 1, borderWidth: 0, paddingRight: 36 }]}
              value={savePassphrase}
              onChangeText={setSavePassphrase}
              secureTextEntry={!showSavePassphrase}
              placeholder="Passphrase (min 4 chars)"
              placeholderTextColor={Colors.textMuted}
              testID="profile-passphrase-input"
            />
            <TouchableOpacity onPress={() => setShowSavePassphrase((v) => !v)} style={styles.eyeIconBtn}>
              <Feather name={showSavePassphrase ? "eye-off" : "eye"} size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : null}
        <TouchableOpacity style={styles.sheetCta} onPress={finalizeSaveAndContinue} testID="save-profile-submit">
          <Text style={styles.sheetCtaText}>SAVE & CONTINUE</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.skipBtn}
          onPress={() => {
            setSaveProfileVisible(false);
            router.replace("/home");
          }}
          testID="save-profile-skip"
        >
          <Text style={styles.skipText}>Skip saving</Text>
        </TouchableOpacity>
      </BottomSheet>
    </SafeAreaView>
  );
}

const mkStyles = (Colors: ColorPalette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  container: { padding: 20, paddingTop: 24, gap: 14 },

  brandRow: { alignItems: "center", marginTop: 8 },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Colors.primary,
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 4,
  },
  title: {
    fontFamily: FONT,
    fontSize: 28,
    fontWeight: "bold",
    color: Colors.text,
    textAlign: "center",
    marginTop: 16,
  },
  subtitle: {
    fontFamily: FONT,
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
    paddingHorizontal: 16,
    lineHeight: 18,
  },

  section: { marginTop: 12 },
  sectionLabel: {
    fontFamily: FONT,
    fontSize: 11,
    fontWeight: "bold",
    color: Colors.textSecondary,
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#F8FAFC",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    gap: 8,
  },
  profileName: { fontFamily: FONT, fontWeight: "bold", fontSize: 14, color: Colors.text },
  profileMeta: { fontFamily: FONT, fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  dotSep: { color: Colors.textMuted },
  unlockBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
  },
  unlockText: { fontFamily: FONT, fontSize: 12, color: Colors.text, fontWeight: "bold" },
  trashBtn: { padding: 6 },
  divider: { flexDirection: "row", alignItems: "center", marginTop: 14, gap: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.borderLight },
  dividerText: { fontFamily: FONT, fontSize: 11, color: Colors.textSecondary },

  fieldGroup: { marginTop: 6 },
  fieldLabelRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  fieldLabel: { fontFamily: FONT, fontSize: 13, fontWeight: "bold", color: Colors.text },
  input: {
    fontFamily: FONT,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: Colors.text,
    backgroundColor: Colors.surface,
  },
  inputWithIcon: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    backgroundColor: Colors.surface,
  },
  eyeIconBtn: { position: "absolute", right: 12, top: 0, bottom: 0, justifyContent: "center" },

  saveBox: {
    marginTop: 6,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderStyle: "dashed",
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  saveBoxHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  saveBoxTitle: { fontFamily: FONT, fontSize: 11, fontWeight: "bold", color: Colors.text, letterSpacing: 1.1 },
  toggleRow: { flexDirection: "row", alignItems: "center" },
  toggleTitle: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, fontSize: 14 },
  toggleDesc: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 2 },

  errorBox: {
    backgroundColor: "#FEF2F2",
    borderColor: Colors.dangerDark,
    borderWidth: 1,
    padding: 12,
    borderRadius: 10,
  },
  errorText: { fontFamily: FONT, color: Colors.dangerDark, fontSize: 13 },

  connectBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 6,
    shadowColor: Colors.primary,
    shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 2,
  },
  connectText: { fontFamily: FONT, color: "#FFFFFF", fontWeight: "bold", fontSize: 16 },

  infoBox: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: Colors.infoBg,
    borderRadius: 10,
    padding: 12,
    marginTop: 6,
  },
  infoText: { flex: 1, fontFamily: FONT, fontSize: 12, color: Colors.infoText, lineHeight: 18 },

  warnBox: {
    backgroundColor: Colors.warnBg,
    borderRadius: 10,
    padding: 12,
    marginTop: 6,
    gap: 10,
  },
  warnText: { flex: 1, fontFamily: FONT, fontSize: 12, color: Colors.warnText, lineHeight: 18 },
  ipChip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.warnChipBg,
    borderRadius: 8,
  },
  ipText: { fontFamily: "Courier", fontWeight: "bold", color: Colors.warnIcon, fontSize: 14, letterSpacing: 1 },

  backendChip: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.borderLight,
    borderRadius: 8,
    marginTop: 8,
  },
  backendChipLabel: {
    fontFamily: FONT,
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: "bold",
  },
  backendChipValue: {
    fontFamily: "Courier",
    fontSize: 12,
    color: Colors.text,
    flexShrink: 1,
  },
  backendChipWarn: {
    fontFamily: FONT,
    fontSize: 11,
    color: Colors.danger,
    flexBasis: "100%",
    marginTop: 2,
  },

  footnote: {
    fontFamily: FONT,
    fontSize: 12,
    color: Colors.textMuted,
    textAlign: "center",
    marginTop: 8,
  },
  kbd: {
    fontFamily: FONT,
    backgroundColor: Colors.borderLight,
    color: Colors.text,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    fontWeight: "bold",
  },

  // Modal sheets
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 24,
  },
  grabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: "center", marginBottom: 16 },
  sheetTitle: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, fontSize: 16 },
  sheetSub: { fontFamily: FONT, color: Colors.textSecondary, marginTop: 6, fontSize: 13, marginBottom: 12 },
  sheetCta: { backgroundColor: Colors.primary, padding: 14, borderRadius: 10, alignItems: "center", marginTop: 16 },
  sheetCtaText: { fontFamily: FONT, color: "#FFF", fontWeight: "bold", letterSpacing: 1 },
  skipBtn: { padding: 12, alignItems: "center", marginTop: 4 },
  skipText: { fontFamily: FONT, color: Colors.textSecondary, fontSize: 13 },
});
