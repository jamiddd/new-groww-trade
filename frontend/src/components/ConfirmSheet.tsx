import { View, Text, StyleSheet, TouchableOpacity } from "react-native";

import { Colors, FONT } from "@/src/theme";
import BottomSheet from "./BottomSheet";

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string;
};

export default function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel = "CONFIRM",
  cancelLabel = "CANCEL",
  destructive = false,
  onConfirm,
  onCancel,
  testID,
}: Props) {
  return (
    <BottomSheet visible={visible} onClose={onCancel} testID={testID}>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.btn, styles.cancelBtn]}
          onPress={onCancel}
          testID={testID ? `${testID}-cancel` : undefined}
        >
          <Text style={styles.cancelText}>{cancelLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, destructive ? styles.dangerBtn : styles.confirmBtn]}
          onPress={onConfirm}
          testID={testID ? `${testID}-confirm` : undefined}
        >
          <Text style={styles.confirmText}>{confirmLabel}</Text>
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: FONT, fontWeight: "bold", fontSize: 16, color: Colors.text },
  message: { fontFamily: FONT, fontSize: 14, color: Colors.textSecondary, marginTop: 8 },
  row: { flexDirection: "row", gap: 12, marginTop: 20, marginBottom: 8 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  cancelBtn: { backgroundColor: Colors.borderLight },
  cancelText: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, letterSpacing: 1 },
  confirmBtn: { backgroundColor: Colors.primary },
  dangerBtn: { backgroundColor: Colors.danger },
  confirmText: { fontFamily: FONT, fontWeight: "bold", color: "#FFF", letterSpacing: 1.2 },
});
