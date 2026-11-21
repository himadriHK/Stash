/**
 * About screen: app identity and the design-system summary (palette,
 * typography) transcribed from the documented Stash design language.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Headline, NoteText, ScreenTitle, SubHeadline } from '../components/FormText';
import { palette } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';

const APP_VERSION = '1.0.0';

const SWATCHES: { label: string; value: string }[] = [
  { label: 'Primary', value: palette.primary },
  { label: 'Secondary', value: palette.secondary },
  { label: 'Tertiary', value: palette.tertiary },
  { label: 'Error', value: palette.error },
];

function SwatchRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.swatchRow}>
      <View style={[styles.swatch, { backgroundColor: value, borderColor: colors.border }]} />
      <Text style={[styles.swatchLabel, { color: colors.text }]}>{label}</Text>
      <Text style={[styles.swatchValue, { color: colors.textMuted }]}>{value}</Text>
    </View>
  );
}

export function AboutScreen() {
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenTitle>About</ScreenTitle>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.hero}>
          <Headline>Stash</Headline>
          <SubHeadline style={styles.heroSub}>Backup client</SubHeadline>
          <NoteText>Version {APP_VERSION}</NoteText>
        </View>

        <Text style={[styles.description, { color: colors.text }]}>
          Stash scans your folders, hashes files locally, uploads them to S3-compatible object
          storage in batches and tracks every transfer through its Kafka pipeline — with full
          light and dark mode support.
        </Text>

        <Text style={[styles.sectionTitle, { color: colors.headline }]}>Design system</Text>
        <View style={styles.swatchList}>
          {SWATCHES.map((swatch) => (
            <SwatchRow key={swatch.label} label={swatch.label} value={swatch.value} />
          ))}
        </View>

        <Text style={[styles.sectionTitle, { color: colors.headline }]}>Typography</Text>
        <Text style={[styles.typeLine, { color: colors.text }]}>
          {FONT_FAMILY.replace('_', ' ')} · Open Sans
        </Text>
        <Text style={[styles.typeSample, { color: colors.text, fontSize: fontSizes.headline }]}>
          Headline 32
        </Text>
        <Text style={[styles.typeSample, { color: colors.text, fontSize: fontSizes.subHeadline }]}>
          Subheadline 24
        </Text>
        <Text style={[styles.typeSample, { color: colors.text, fontSize: fontSizes.body }]}>
          Body 14
        </Text>
        <Text style={[styles.typeSample, { color: colors.textMuted, fontSize: fontSizes.small }]}>
          Caption 12
        </Text>

        <NoteText style={styles.footerNote}>
          React Native (Expo) client with feature parity to Stash.Maui.
        </NoteText>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 32,
  },
  hero: {
    alignItems: 'center',
    marginTop: 24,
    gap: 4,
  },
  heroSub: {
    fontSize: fontSizes.body,
  },
  description: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    lineHeight: 20,
    marginHorizontal: 16,
    marginTop: 24,
    textAlign: 'center',
  },
  sectionTitle: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.subHeadline * 0.8,
    marginTop: 28,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  swatchList: {
    marginHorizontal: 16,
    gap: 8,
  },
  swatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
  },
  swatchLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    flex: 1,
  },
  swatchValue: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
  },
  typeLine: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    marginHorizontal: 16,
    marginBottom: 4,
  },
  typeSample: {
    fontFamily: FONT_FAMILY,
    marginHorizontal: 16,
    marginTop: 4,
  },
  footerNote: {
    marginTop: 28,
    marginHorizontal: 16,
    textAlign: 'center',
  },
});
