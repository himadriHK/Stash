import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppButton } from './AppButton';
import { NoteText } from './FormText';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import { Text } from 'react-native';

interface EmptyStateProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  subtitle: string;
  buttonLabel?: string;
  onButtonPress?: () => void;
}

/** Empty list state: icon, title, subtitle and a Primary CTA. */
export function EmptyState({ icon, title, subtitle, buttonLabel, onButtonPress }: EmptyStateProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.container}>
      <Ionicons name={icon} size={64} color={colors.disabledText} />
      <Text style={[styles.title, { color: colors.textMuted }]}>{title}</Text>
      <NoteText style={styles.subtitle}>{subtitle}</NoteText>
      {buttonLabel && onButtonPress ? (
        <View style={styles.button}>
          <AppButton title={buttonLabel} onPress={onButtonPress} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontFamily: FONT_FAMILY,
    fontSize: 18,
    marginTop: 16,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    textAlign: 'center',
  },
  button: {
    marginTop: 24,
    alignSelf: 'stretch',
  },
});
