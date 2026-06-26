/**
 * Full-screen loading overlay used during initial catalog hydrate.
 * Non-dismissable — the parent unmounts it when hydration finishes.
 */
import { useMemo } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { FONT, type ColorPalette } from "@/src/theme";
import { useTheme } from "@/src/theme/ThemeProvider";

type Props = {
  visible: boolean;
  title?: string;
  message?: string;
  /** When set, shows a Retry button + the error message. */
  errorMessage?: string | null;
  onRetry?: () => void;
};

export default function CatalogLoadingDialog({
  visible,
  title = "Syncing your instruments",
  message = "Fetching the latest underlyings and expiry dates from Groww.\nThis runs once after login and is then cached locally.",
  errorMessage,
  onRetry,
}: Props) {
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {!errorMessage ? (
            <>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.message}>{message}</Text>
            </>
          ) : (
            <>
              <Text style={[styles.title, { color: Colors.danger }]}>Sync failed</Text>
              <Text style={styles.message}>{errorMessage}</Text>
              {onRetry ? (
                <TouchableOpacity onPress={onRetry} style={styles.retryBtn} testID="catalog-retry">
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const mkStyles = (Colors: ColorPalette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 360,
      backgroundColor: Colors.surface,
      borderRadius: 16,
      padding: 24,
      alignItems: "center",
      gap: 16,
    },
    title: {
      fontFamily: FONT,
      fontSize: 16,
      fontWeight: "bold",
      color: Colors.text,
      textAlign: "center",
    },
    message: {
      fontFamily: FONT,
      fontSize: 13,
      color: Colors.textSecondary,
      textAlign: "center",
      lineHeight: 18,
    },
    retryBtn: {
      marginTop: 4,
      paddingHorizontal: 24,
      paddingVertical: 10,
      backgroundColor: Colors.primary,
      borderRadius: 8,
    },
    retryText: {
      fontFamily: FONT,
      fontSize: 14,
      fontWeight: "bold",
      color: "#FFFFFF",
    },
  });
