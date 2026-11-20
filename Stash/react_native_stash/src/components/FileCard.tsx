import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { FileEntity } from '../models/fileEntity';
import {
  uploadStatusColor,
  uploadStatusDisplayName,
  uploadStatusIcon,
} from '../models/uploadStatus';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import { formatFileSize } from '../utils/format';

interface FileCardProps {
  file: FileEntity;
  onPress: (file: FileEntity) => void;
  onMorePress: (file: FileEntity) => void;
}

function withAlpha(hexColor: string, alphaHex: string): string {
  return hexColor.length === 7 ? `${hexColor}${alphaHex}` : hexColor;
}

/**
 * File row documented for the Files screen: status icon chip (colour per
 * status), name, size, coloured status line, error line in #B00020, and an
 * overflow action.
 */
export function FileCard({ file, onPress, onMorePress }: FileCardProps) {
  const { colors } = useTheme();
  const statusColor = uploadStatusColor(file.status);

  return (
    <Pressable
      onPress={() => onPress(file)}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={[styles.chip, { backgroundColor: withAlpha(statusColor, '1A') }]}>
        <Ionicons
          name={uploadStatusIcon(file.status) as React.ComponentProps<typeof Ionicons>['name']}
          size={20}
          color={statusColor}
        />
      </View>

      <View style={styles.body}>
        <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
          {file.fileName}
        </Text>
        <Text style={[styles.meta, { color: colors.textMuted }]}>
          Size: {formatFileSize(file.fileSize)}
        </Text>
        <Text style={[styles.meta, { color: statusColor }]}>
          Status: {uploadStatusDisplayName(file.status)}
        </Text>
        {file.errorMessage ? (
          <Text numberOfLines={3} style={[styles.meta, styles.error, { color: colors.error }]}>
            Error: {file.errorMessage}
          </Text>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${file.fileName}`}
        hitSlop={8}
        onPress={() => onMorePress(file)}
        style={({ pressed }) => [styles.more, pressed ? styles.pressed : null]}
      >
        <Ionicons name="ellipsis-vertical" size={20} color={colors.textMuted} />
      </Pressable>
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
  chip: {
    padding: 6,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    marginHorizontal: 12,
  },
  name: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  meta: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    marginTop: 2,
  },
  error: {
    fontStyle: 'italic',
    marginTop: 4,
  },
  more: {
    padding: 4,
  },
});
