import { useEffect } from "react";
import { ActivityIndicator, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

import { getToken } from "@/src/api/client";
import { Colors } from "@/src/theme";

export default function Index() {
  const router = useRouter();

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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.bg,
  },
});
