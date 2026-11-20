import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { FolderConfig } from '../models/folderConfig';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';

interface FolderRowProps {
  folder: FolderConfig;
  onPress: (folder: FolderConfig) => void;
  onToggle: (folder: FolderConfig, enabled: boolean) => void;
}

/**
 * Folder row documented for the Folders screen: folder/folder-off icon, name,
 * path subtitle, enable switch (Primary), tap for folder actions.
 */
export function FolderRow({ folder, onPress, onToggle }: FolderRowProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={() => onPress(folder)}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        pressed ? styles.pressed : null,
      ]}
    >
      <Ionicons
        name={folder.isEnabled ? 'folder' : 'folder-outline'}
        size={24}
        color={folder.isEnabled ? colors.link : colors.disabledText}
      />
      <View style={styles.body}>
        <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
          {folder.folderName}
        </Text>
        <Text numberOfLines={1} style={[styles.path, { color: colors.textMuted }]}>
          {folder.folderPath}
        </Text>
      </View>
      <Switch
        value={folder.isEnabled}
        onValueChange={(value) => onToggle(folder, value)}
        trackColor={{ true: colors.switchTrackOn, false: colors.switchTrackOff }}
        thumbColor={colors.switchThumb}
        accessibilityLabel={`${folder.folderName} enabled`}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginVertical: 6,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  pressed: {
    opacity: 0.85,
  },
  body: {
    flex: 1,
    marginHorizontal: 12,
  },
  name: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  path: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    marginTop: 2,
  },
});
