import { ReactNode, useEffect } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
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
 * - draggable down to dismiss (swipe / fling)
 * - hairline (1dp) divider on top
 * - optionally translates up to clear the on-screen keyboard
 */
export default function BottomSheet({ visible, onClose, children, avoidKeyboard = false, testID }: Props) {
  const { height: kbHeight } = useReanimatedKeyboardAnimation();
  const dragY = useSharedValue(0);

  // Reset drag offset every time the sheet opens.
  useEffect(() => {
    if (visible) dragY.value = 0;
  }, [visible, dragY]);

  // Pan gesture for drag-to-dismiss.
  // `activeOffsetY: [-9999, 8]` means the gesture only activates on a >=8 px
  // downward drag — this keeps inner ScrollViews/FlatLists scrolling normally
  // while still allowing the sheet to be flicked away.
  const pan = Gesture.Pan()
    .activeOffsetY([-9999, 8])
    .onChange((e) => {
      dragY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      const shouldClose = e.translationY > 100 || e.velocityY > 800;
      if (shouldClose) {
        dragY.value = withTiming(700, { duration: 180 }, (finished) => {
          if (finished) runOnJS(onClose)();
        });
      } else {
        dragY.value = withSpring(0, { damping: 18, stiffness: 220 });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: (avoidKeyboard ? kbHeight.value : 0) + dragY.value },
    ],
  }));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          testID={testID ? `${testID}-backdrop` : undefined}
        />
        <GestureDetector gesture={pan}>
          <Animated.View style={sheetStyle}>
            <SafeAreaView edges={["bottom"]} style={styles.sheetBg}>
              <View style={styles.sheet} testID={testID}>
                <View style={styles.grabber} />
                {children}
              </View>
            </SafeAreaView>
          </Animated.View>
        </GestureDetector>
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
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: Colors.border,
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
