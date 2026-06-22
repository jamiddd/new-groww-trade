import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api, Preset } from "@/src/api/client";
import { Colors, FONT } from "@/src/theme";
import BottomSheet from "@/src/components/BottomSheet";

const STRIKE_OPTIONS = ["HIGH_GAMMA", "ATM", "OTM1", "OTM2", "ITM1"];
const IV_OPTIONS = ["LOW_IV", "HIGH_IV", "ANY"];
const ORDER_TYPE_OPTIONS = ["MARKET", "LIMIT"];

const STRIKE_LABELS: Record<string, string> = {
  HIGH_GAMMA: "High Gamma",
  ATM: "At-the-money",
  OTM1: "OTM +1",
  OTM2: "OTM +2",
  ITM1: "ITM -1",
};
const IV_LABELS: Record<string, string> = {
  LOW_IV: "Low IV",
  HIGH_IV: "High IV",
  ANY: "Any",
};

export default function PresetScreen() {
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  const [preset, setPreset] = useState<Preset | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pickerType, setPickerType] = useState<null | "strike" | "iv" | "order" | "size" | "sl" | "tp" | "limit">(null);
  const [tempNum, setTempNum] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const p = await api.getPreset(key!);
        setPreset(p);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load preset");
      } finally {
        setLoading(false);
      }
    })();
  }, [key]);

  const update = (patch: Partial<Preset>) => preset && setPreset({ ...preset, ...patch });

  const save = async () => {
    if (!preset) return;
    setSaving(true);
    try {
      await api.updatePreset(preset.key, preset);
      router.back();
    } catch (e: any) {
      setError(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !preset) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={Colors.primary} style={{ marginTop: 32 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]} testID="preset-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="preset-back">
          <Text style={styles.headerBack}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{preset.label}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView style={{ flex: 1 }}>
        <Row
          title="STRIKE SELECTION CRITERIA"
          description="Set how the BUY button will choose the strike at the time of buying."
          value={STRIKE_LABELS[preset.strike_selection] ?? preset.strike_selection}
          onPress={() => setPickerType("strike")}
          testID="row-strike"
        />
        <Row
          title="IMPLIED VOLATILITY"
          description="Set IV low or high when buying"
          value={IV_LABELS[preset.iv_filter] ?? preset.iv_filter}
          onPress={() => setPickerType("iv")}
          testID="row-iv"
        />
        <Row
          title="POSITION SIZING"
          description="Set how much capital should be used while placing this order."
          value={`${preset.position_sizing_pct}%`}
          onPress={() => {
            setTempNum(String(preset.position_sizing_pct));
            setPickerType("size");
          }}
          testID="row-size"
        />
        <Row
          title="RISK MANAGEMENT"
          description="Set exit criteria for this trade."
          value={`${preset.stop_loss_pct}% SL${preset.take_profit_pct ? `, ${preset.take_profit_pct}% TP` : ", No TP"}`}
          onPress={() => {
            setTempNum(String(preset.stop_loss_pct));
            setPickerType("sl");
          }}
          testID="row-sl"
        />
        <Row
          title="TAKE PROFIT"
          description="0% disables Take Profit."
          value={`${preset.take_profit_pct}%`}
          onPress={() => {
            setTempNum(String(preset.take_profit_pct));
            setPickerType("tp");
          }}
          testID="row-tp"
        />
        <Row
          title="ORDER TYPE"
          description="Market = fill immediately. Limit = sit on book."
          value={preset.order_type}
          onPress={() => setPickerType("order")}
          testID="row-order"
        />
        {preset.order_type === "LIMIT" ? (
          <Row
            title="LIMIT OFFSET"
            description="% above LTP when placing BUY LMT order."
            value={`${preset.limit_offset_pct}%`}
            onPress={() => {
              setTempNum(String(preset.limit_offset_pct));
              setPickerType("limit");
            }}
            testID="row-limit"
          />
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity onPress={save} testID="preset-update">
          <Text style={[styles.footerBtn, { color: Colors.primary }]}>{saving ? "Saving…" : "Update"}</Text>
        </TouchableOpacity>
      </View>

      {/* Picker modals */}
      <ListPicker
        visible={pickerType === "strike"}
        title="Strike Selection"
        options={STRIKE_OPTIONS}
        labels={STRIKE_LABELS}
        value={preset.strike_selection}
        onPick={(v) => {
          update({ strike_selection: v });
          setPickerType(null);
        }}
        onClose={() => setPickerType(null)}
      />
      <ListPicker
        visible={pickerType === "iv"}
        title="Implied Volatility"
        options={IV_OPTIONS}
        labels={IV_LABELS}
        value={preset.iv_filter}
        onPick={(v) => {
          update({ iv_filter: v });
          setPickerType(null);
        }}
        onClose={() => setPickerType(null)}
      />
      <ListPicker
        visible={pickerType === "order"}
        title="Order Type"
        options={ORDER_TYPE_OPTIONS}
        labels={{ MARKET: "Market", LIMIT: "Limit" }}
        value={preset.order_type}
        onPick={(v) => {
          update({ order_type: v });
          setPickerType(null);
        }}
        onClose={() => setPickerType(null)}
      />
      <NumberPicker
        visible={pickerType === "size"}
        title="Position Sizing %"
        value={tempNum}
        onChange={setTempNum}
        onClose={() => setPickerType(null)}
        onSave={(v) => {
          update({ position_sizing_pct: v });
          setPickerType(null);
        }}
      />
      <NumberPicker
        visible={pickerType === "sl"}
        title="Stop Loss %"
        value={tempNum}
        onChange={setTempNum}
        onClose={() => setPickerType(null)}
        onSave={(v) => {
          update({ stop_loss_pct: v });
          setPickerType(null);
        }}
      />
      <NumberPicker
        visible={pickerType === "tp"}
        title="Take Profit %"
        value={tempNum}
        onChange={setTempNum}
        onClose={() => setPickerType(null)}
        onSave={(v) => {
          update({ take_profit_pct: v });
          setPickerType(null);
        }}
      />
      <NumberPicker
        visible={pickerType === "limit"}
        title="Limit Offset %"
        value={tempNum}
        onChange={setTempNum}
        onClose={() => setPickerType(null)}
        onSave={(v) => {
          update({ limit_offset_pct: v });
          setPickerType(null);
        }}
      />

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function Row({
  title,
  description,
  value,
  onPress,
  testID,
}: {
  title: string;
  description: string;
  value: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} testID={testID}>
      <View style={{ flex: 1, paddingRight: 16 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDesc}>{description}</Text>
      </View>
      <Text style={styles.rowValue}>{value}</Text>
    </TouchableOpacity>
  );
}

function ListPicker({
  visible,
  title,
  options,
  labels,
  value,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: string[];
  labels: Record<string, string>;
  value: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose} testID={`picker-${title}`}>
      <Text style={styles.sheetTitle}>{title}</Text>
      <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingBottom: 8 }}>
        {options.map((opt) => (
          <TouchableOpacity
            key={opt}
            style={styles.optRow}
            onPress={() => onPick(opt)}
            testID={`picker-option-${opt}`}
          >
            <Text style={styles.optText}>{labels[opt] ?? opt}</Text>
            {value === opt ? <Text style={styles.optCheck}>✓</Text> : null}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

function NumberPicker({
  visible,
  title,
  value,
  onChange,
  onClose,
  onSave,
}: {
  visible: boolean;
  title: string;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onSave: (v: number) => void;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose} avoidKeyboard testID={`number-picker-${title}`}>
      <Text style={styles.sheetTitle}>{title}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        autoFocus
        testID="number-picker-input"
      />
      <TouchableOpacity
        style={styles.saveBtn}
        onPress={() => onSave(Number(value) || 0)}
        testID="number-picker-save"
      >
        <Text style={styles.saveText}>SAVE</Text>
      </TouchableOpacity>
    </BottomSheet>
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
  headerTitle: { fontFamily: FONT, color: Colors.text, fontWeight: "bold", fontSize: 14, letterSpacing: 0.8, flex: 1, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowTitle: { fontFamily: FONT, fontSize: 11, fontWeight: "bold", color: Colors.text, letterSpacing: 1.1 },
  rowDesc: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  rowValue: { fontFamily: FONT, fontSize: 13, color: Colors.primary, fontWeight: "bold" },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 24,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  footerBtn: { fontFamily: FONT, fontWeight: "bold", letterSpacing: 0.8, fontSize: 14 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: "#FFF",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 24,
  },
  grabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: "center", marginBottom: 16 },
  sheetTitle: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, fontSize: 15 },
  optRow: {
    flexDirection: "row",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    alignItems: "center",
  },
  optText: { fontFamily: FONT, fontSize: 14, color: Colors.text, flex: 1 },
  optCheck: { fontFamily: FONT, color: Colors.primary, fontWeight: "bold" },
  input: {
    fontFamily: FONT,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 14,
    marginTop: 12,
    fontSize: 16,
    color: Colors.text,
  },
  saveBtn: { backgroundColor: Colors.primary, padding: 14, borderRadius: 10, alignItems: "center", marginTop: 16 },
  saveText: { fontFamily: FONT, color: "#FFF", fontWeight: "bold", letterSpacing: 1.2 },

  errorBox: {
    backgroundColor: "#FEF2F2",
    borderColor: Colors.dangerDark,
    borderWidth: 1,
    padding: 12,
    borderRadius: 8,
    margin: 16,
  },
  errorText: { fontFamily: FONT, color: Colors.dangerDark, fontSize: 13 },
});
