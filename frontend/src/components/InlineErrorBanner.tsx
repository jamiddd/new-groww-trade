/**
 * Inline error banner — designed for top-of-screen, non-floating, user-
 * dismissable errors. Pushes the page content below it (does NOT overlay).
 *
 * Visual reference: pale-orange background, orange text, alert-circle icon
 * on the left, X close button on the right, max 3 lines of body text with
 * tail ellipsis (so a long stacktrace doesn't blow the layout).
 *
 *   <InlineErrorBanner
 *     message={errMsg}
 *     onDismiss={() => setError(null)}
 *   />
 *
 * The banner stays visible until the user taps X (or the parent clears the
 * `message` prop). It does NOT auto-dismiss — that's intentional for
 * trading errors where the user needs time to read and act.
 */
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { FONT, type ColorPalette } from "@/src/theme";
import { useTheme } from "@/src/theme/ThemeProvider";

type Props = {
  message: string | null | undefined;
  onDismiss: () => void;
  /** Optional override for the max line count (default 3). */
  maxLines?: number;
  testID?: string;
};

export default function InlineErrorBanner({
  message,
  onDismiss,
  maxLines = 3,
  testID = "inline-error-banner",
}: Props) {
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);

  if (!message) return null;

  return (
    <View style={styles.banner} testID={testID}>
      <Feather
        name="alert-circle"
        size={20}
        color={Colors.warnIcon}
        style={styles.icon}
      />
      <Text
        style={styles.message}
        numberOfLines={maxLines}
        ellipsizeMode="tail"
      >
        {message}
      </Text>
      <Pressable
        onPress={onDismiss}
        hitSlop={12}
        style={styles.closeBtn}
        testID={`${testID}-dismiss`}
        accessibilityRole="button"
        accessibilityLabel="Dismiss error"
      >
        <Feather name="x" size={20} color={Colors.warnIcon} />
      </Pressable>
    </View>
  );
}

const mkStyles = (Colors: ColorPalette) =>
  StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      backgroundColor: Colors.warnBg,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginHorizontal: 16,
      marginTop: 12,
    },
    icon: {
      marginTop: 1,
    },
    message: {
      flex: 1,
      fontFamily: FONT,
      fontSize: 14,
      lineHeight: 20,
      color: Colors.warnText,
    },
    closeBtn: {
      paddingLeft: 4,
      paddingTop: 1,
    },
  });
