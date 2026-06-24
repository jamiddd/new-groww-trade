import { useEffect, useMemo } from "react";
import { ActivityIndicator, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

import { getToken } from "@/src/api/client";
import { ColorPalette } from "@/src/theme";
import { useTheme } from "@/src/theme/ThemeProvider";

export default function Index() {
  const router = useRouter();
  const { Colors } = useTheme();
  const styles = useMemo(() => mkStyles(Colors), [Colors]);

  useEffect(() => {
    (async () => {
      const t = await getToken();
      if (t) {
        router.replace("/home");
      } else {
        router.replace("/login");
      }
    })();
  }, [router]);

  return (
    <View style={styles.container} testID="bootstrap-screen">
      <ActivityIndicator size="large" color={Colors.primary} />
    </View>
  );
}

const mkStyles = (Colors: ColorPalette) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.bg,
    },
  });
