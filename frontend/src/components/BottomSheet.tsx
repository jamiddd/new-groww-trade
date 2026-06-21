import { ReactNode } from "react";
import {
  Modal,
  View,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Colors } from "@/src/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Avoid keyboard on iOS — set to true for sheets with TextInputs. */
  avoidKeyboard?: boolean;
  testID?: string;
};

/**
 * Bottom-anchored sheet that:
 * - dims everything above with a tappable backdrop
 * - extends the white background into the bottom safe area
 * - sizes itself to its content (children control max-height via ScrollView)
 */
export default function BottomSheet({ visible, onClose, children, avoidKeyboard = false, testID }: Props) {
  const Wrapper: any = avoidKeyboard ? KeyboardAvoidingView : View;
  const wrapperProps = avoidKeyboard ? { behavior: Platform.OS === "ios" ? "padding" : undefined } : {};
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Wrapper style={styles.root} {...wrapperProps}>
        <Pressable style={styles.backdrop} onPress={onClose} testID={testID ? `${testID}-backdrop` : undefined} />
        <SafeAreaView edges={["bottom"]} style={styles.sheetBg}>
          <View style={styles.sheet} testID={testID}>
            <View style={styles.grabber} />
            {children}
          </View>
        </SafeAreaView>
      </Wrapper>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
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
