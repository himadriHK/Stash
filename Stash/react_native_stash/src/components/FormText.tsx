import React, { type ReactNode } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';

interface TextProps {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  testID?: string;
  numberOfLines?: number;
}

/** Headline: 32px, centered, MidnightBlue (light) / White (dark). */
export function Headline({ children, style, testID }: TextProps) {
  const { colors } = useTheme();
  return (
    <Text
      testID={testID}
      style={[styles.headline, { color: colors.headline }, style]}
      accessibilityRole="header"
    >
      {children}
    </Text>
  );
}

/** SubHeadline: 24px, centered, MidnightBlue (light) / White (dark). */
export function SubHeadline({ children, style, testID }: TextProps) {
  const { colors } = useTheme();
  return (
    <Text
      testID={testID}
      style={[styles.subHeadline, { color: colors.headline }, style]}
      accessibilityRole="header"
    >
      {children}
    </Text>
  );
}

/** Default Label: 14px, Black (light) / White (dark). */
export function BodyText({ children, style, testID, numberOfLines }: TextProps) {
  const { colors } = useTheme();
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[styles.body, { color: colors.text }, style]}>
      {children}
    </Text>
  );
}

/** Device-ID note: 12px, Gray500 (light) / Gray300 (dark). */
export const NoteText = React.memo(function NoteText({
  children,
  style,
  testID,
  numberOfLines,
}: TextProps) {
  const { colors } = useTheme();
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[styles.small, { color: colors.note }, style]}>
      {children}
    </Text>
  );
});

/** Error label: default 14px, #B00020. Renders nothing when empty. */
export function ErrorText({ children, style, testID }: TextProps) {
  const { colors } = useTheme();
  if (!children) {
    return null;
  }
  return (
    <Text testID={testID} style={[styles.body, styles.error, { color: colors.error }, style]}>
      {children}
    </Text>
  );
}

/** In-screen section title used by the main tab screens. */
export const ScreenTitle = React.memo(function ScreenTitle({
  children,
  style,
  testID,
}: TextProps) {
  const { colors } = useTheme();
  return (
    <Text testID={testID} style={[styles.screenTitle, { color: colors.headline }, style]}>
      {children}
    </Text>
  );
});

const styles = StyleSheet.create({
  headline: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.headline,
    textAlign: 'center',
  },
  subHeadline: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.subHeadline,
    textAlign: 'center',
  },
  body: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  small: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
  },
  error: {
    color: '#B00020',
  },
  screenTitle: {
    fontFamily: FONT_FAMILY,
    fontSize: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
});
