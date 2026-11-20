import React from 'react';
import { StyleSheet, TextInput, type TextInputProps } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';

interface FormInputProps extends TextInputProps {
  testID?: string;
}

/**
 * Entry equivalent: transparent background, 14px OpenSans, themed placeholder
 * color (Gray200 light / Gray500 dark), minimum height 44.
 */
export function FormInput({ style, testID, ...rest }: FormInputProps) {
  const { colors } = useTheme();
  return (
    <TextInput
      testID={testID}
      placeholderTextColor={colors.placeholder}
      selectionColor={colors.primarySolid}
      style={[
        styles.input,
        { color: colors.inputText, borderBottomColor: colors.border },
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    minHeight: 44,
    paddingHorizontal: 0,
    paddingVertical: 10,
    width: '100%',
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
});
