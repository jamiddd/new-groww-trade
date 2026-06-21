import { useEffect, useRef } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  Animated,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Colors, FONT } from "@/src/theme";

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
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) {
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    } else {
      opacity.setValue(0);
    }
  }, [visible, opacity]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} testID={testID ? `${testID}-backdrop` : undefined}>
        <Animated.View style={[styles.fade, { opacity }]} />
      </Pressable>
      <SafeAreaView style={styles.sheetWrap} edges={["bottom"]}>
        <View style={styles.sheet} testID={testID}>
          <View style={styles.grabber} />
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
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject },
  fade: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: "#FFF",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: "center",
    marginBottom: 16,
  },
  title: { fontFamily: FONT, fontWeight: "bold", fontSize: 16, color: Colors.text },
  message: { fontFamily: FONT, fontSize: 14, color: Colors.textSecondary, marginTop: 8 },
  row: { flexDirection: "row", gap: 12, marginTop: 20 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  cancelBtn: { backgroundColor: Colors.borderLight },
  cancelText: { fontFamily: FONT, fontWeight: "bold", color: Colors.text, letterSpacing: 1 },
  confirmBtn: { backgroundColor: Colors.primary },
  dangerBtn: { backgroundColor: Colors.danger },
  confirmText: { fontFamily: FONT, fontWeight: "bold", color: "#FFF", letterSpacing: 1.2 },
});
