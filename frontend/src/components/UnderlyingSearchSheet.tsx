import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ColorPalette, FONT } from "@/src/theme";
import { useTheme } from "@/src/theme/ThemeProvider";
import { searchUnderlyings as searchBundledUnderlyings } from "@/src/data/underlyings";
import { selectUnderlyings as searchCatalog, isLoaded as isCatalogLoaded } from "@/src/state/catalog";

type UnderlyingItem = { symbol: string; name: string; type: string };

type Props = {
  visible: boolean;
  onPick: (item: UnderlyingItem) => void;
  onClose: () => void;
};

export default function UnderlyingSearchSheet({ visible, onPick, onClose }: Props) {
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<UnderlyingItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    // Bundled JSON → instant client-side search. No API call, no spinner
    // longer than a frame.
    setLoading(true);
    const t = setTimeout(() => {
      try {
        // Prefer the master-derived catalog (synced at login). Bundled JSON
        // remains a fallback for the rare case the catalog hasn't loaded
        // yet (e.g. first-ever launch before hydrate completes).
        const source = isCatalogLoaded() ? searchCatalog(q) : searchBundledUnderlyings(q);
        setItems(source as UnderlyingItem[]);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 0);
    return () => {
      clearTimeout(t);
    };
  }, [q, visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.closeBtn} testID="underlying-search-close">
            <Text style={styles.closeText}>CLOSE</Text>
          </Pressable>
          <Text style={styles.title}>SEARCH UNDERLYING</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={styles.searchRow}>
          <TextInput
            testID="underlying-search-input"
            style={styles.input}
            placeholder="NIFTY, BANKNIFTY, RELIANCE…"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            value={q}
            onChangeText={setQ}
          />
        </View>
        {loading ? (
          <ActivityIndicator style={{ marginTop: 24 }} color={Colors.primary} />
        ) : (
          <FlatList
            data={items}
            keyExtractor={(i) => i.symbol}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.row}
                onPress={() => onPick(item)}
                testID={`underlying-row-${item.symbol}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowSymbol}>{item.symbol}</Text>
                  {item.name && item.name !== item.symbol ? (
                    <Text style={styles.rowName}>{item.name}</Text>
                  ) : null}
                </View>
                <Text style={styles.rowType}>{item.type}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>No matching underlyings.</Text>
            }
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const mkStyles = (Colors: ColorPalette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  closeBtn: { width: 60 },
  closeText: { fontFamily: FONT, color: Colors.primary, fontWeight: "bold", fontSize: 12, letterSpacing: 1 },
  title: { fontFamily: FONT, fontWeight: "bold", fontSize: 14, color: Colors.text, letterSpacing: 1.2 },
  searchRow: { padding: 12 },
  input: {
    fontFamily: FONT,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 14,
    color: Colors.text,
    backgroundColor: Colors.pillBg,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    alignItems: "center",
  },
  rowSymbol: { fontFamily: FONT, fontWeight: "bold", fontSize: 14, color: Colors.text },
  rowName: { fontFamily: FONT, fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  rowType: {
    fontFamily: FONT,
    fontSize: 10,
    color: Colors.primary,
    backgroundColor: "rgba(26,77,255,0.08)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    fontWeight: "bold",
    letterSpacing: 0.8,
  },
  empty: { fontFamily: FONT, color: Colors.textMuted, textAlign: "center", marginTop: 24 },
});
