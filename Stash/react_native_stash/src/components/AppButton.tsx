import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes, layout } from '../theme/typography';

export type AppButtonVariant = 'primary' | 'link';

interface AppButtonProps {
  title: string;
  onPress?: () => void;
  disabled?: boolean;
  variant?: AppButtonVariant;
  testID?: string;
}

/**
 * Button styles transcribed from Stash.Maui Styles.xaml: CornerRadius 8,
 * Padding 14,10, MinimumHeight 44, FontSize 14, Primary background with
 * theme-aware disabled states; the link variant is a transparent background
 * with Primary (light) / White (dark) text.
 */
export const AppButton = React.memo(function AppButton({
  title,
  onPress,
  disabled = false,
  variant = 'primary',
  testID,
}: AppButtonProps) {
  const { colors } = useTheme();
  const isLink = variant === 'link';

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        isLink ? styles.link : styles.primary,
        isLink
          ? { backgroundColor: 'transparent' }
          : { backgroundColor: disabled ? colors.disabledButtonBg : colors.primary },
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color: isLink
              ? disabled
                ? colors.disabledText
                : colors.link
              : disabled
                ? colors.disabledButtonText
                : colors.onPrimary,
          },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: {
    minHeight: layout.buttonMinHeight,
    borderRadius: layout.buttonRadius,
    paddingHorizontal: layout.buttonPaddingHorizontal,
    paddingVertical: layout.buttonPaddingVertical,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {},
  link: {},
  pressed: {
    opacity: 0.8,
  },
  label: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    textAlign: 'center',
  },
});
