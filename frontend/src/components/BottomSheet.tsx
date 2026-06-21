import { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";

import { Colors } from "@/src/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Translate the sheet up by the keyboard height when it opens. */
  avoidKeyboard?: boolean;
  testID?: string;
};

/**
 * Bottom-anchored sheet:
 * - dims everything above with a tappable backdrop
 * - extends the white background into the bottom safe area
 * - sizes itself to its content
 * - optionally translates up to clear the on-screen keyboard
 */
export default function BottomSheet({ visible, onClose, children, avoidKeyboard = false, testID }: Props) {
  const { height } = useReanimatedKeyboardAnimation();

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: avoidKeyboard ? height.value : 0 }],
  }));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          testID={testID ? `${testID}-backdrop` : undefined}
        />
        <Animated.View style={sheetStyle}>
          <SafeAreaView edges={["bottom"]} style={styles.sheetBg}>
            <View style={styles.sheet} testID={testID}>
              <View style={styles.grabber} />
              {children}
            </View>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "transparent" },
  sheetBg: { backgroundColor: "#FFFFFF" },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 8,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: "center",
    marginBottom: 12,
  },
});
