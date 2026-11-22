import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSyncProgress } from '../hooks/useSyncProgress';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';

/**
 * Sync progress row.
 *
 * This subscribes to sync progress on its own so the surrounding screen (and a
 * large media grid) is not re-rendered on every progress tick. A sync pass
 * publishes progress several times per second; re-rendering the whole gallery
 * for each tick is what made the JS thread jank while syncing.
 */
export const SyncBanner = React.memo(function SyncBanner() {
  const { colors } = useTheme();
  const { label } = useSyncProgress();

  if (!label) {
    return null;
  }

  return (
    <View style={[styles.syncRow, { backgroundColor: colors.card }]}>
      <ActivityIndicator size="small" color={colors.primarySolid} />
      <Text style={[styles.syncLabel, { color: colors.text }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  syncLabel: {
    flex: 1,
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
  },
});