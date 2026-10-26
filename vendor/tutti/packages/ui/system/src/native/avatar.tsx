import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
  type ViewStyle
} from "react-native";
import { type NativeTheme } from "./tokens";
import { useNativeTheme } from "./theme-provider";

export type NativeAvatarSize = "compact" | "regular" | "large";

export interface NativeAvatarProps {
  initial?: string;
  label: string;
  loading?: boolean;
  size?: NativeAvatarSize;
  src?: string | null;
  style?: StyleProp<ViewStyle>;
}

function avatarInitial(label: string, initial?: string): string {
  const value = initial?.trim() || label.trim();
  return Array.from(value)[0]?.toLocaleUpperCase() || "?";
}

/** Decorative identity image with loading and broken-image fallback states. */
export function NativeAvatar({
  initial,
  label,
  loading = false,
  size = "regular",
  src,
  style
}: NativeAvatarProps) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const normalizedSrc = src?.trim() ?? "";
  const [failedSrc, setFailedSrc] = useState("");
  const [loadedSrc, setLoadedSrc] = useState("");

  useEffect(() => {
    setFailedSrc("");
    setLoadedSrc("");
  }, [normalizedSrc]);

  const imageAvailable =
    !loading && normalizedSrc.length > 0 && failedSrc !== normalizedSrc;
  const imageLoaded = imageAvailable && loadedSrc === normalizedSrc;
  const dimension = avatarDimensions(theme)[size];
  const imageStyle: StyleProp<ImageStyle> = [
    styles.image,
    imageLoaded ? styles.imageVisible : styles.imageHidden
  ];

  return (
    <View
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[styles.root, dimension, style]}
    >
      {loading || imageAvailable ? (
        imageLoaded ? null : (
          <ActivityIndicator color={theme.color.muted} size="small" />
        )
      ) : (
        <Text numberOfLines={1} style={styles.initial}>
          {avatarInitial(label, initial)}
        </Text>
      )}
      {imageAvailable ? (
        <Image
          onError={() => setFailedSrc(normalizedSrc)}
          onLoad={() => setLoadedSrc(normalizedSrc)}
          resizeMode="cover"
          source={{ uri: normalizedSrc }}
          style={imageStyle}
        />
      ) : null}
    </View>
  );
}

function avatarDimensions(
  theme: NativeTheme
): Record<NativeAvatarSize, ViewStyle> {
  return {
    compact: {
      height: theme.control.compact,
      width: theme.control.compact
    },
    large: {
      height: theme.control.row,
      width: theme.control.row
    },
    regular: {
      height: theme.control.regular,
      width: theme.control.regular
    }
  };
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    image: {
      height: "100%",
      left: 0,
      position: "absolute",
      top: 0,
      width: "100%"
    },
    imageHidden: { opacity: 0 },
    imageVisible: { opacity: 1 },
    initial: {
      color: theme.color.text,
      fontSize: theme.space.medium,
      fontWeight: "700"
    },
    root: {
      alignItems: "center",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.control.row / 2,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      overflow: "hidden"
    }
  });
}
