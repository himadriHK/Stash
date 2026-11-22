import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { FileEntity } from '../models/fileEntity';
import {
  UploadStatus,
  uploadStatusColor,
  uploadStatusIcon,
} from '../models/uploadStatus';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY } from '../theme/typography';

interface MediaTileProps {
  file: FileEntity;
  selected: boolean;
  favorite: boolean;
  onPress: () => void;
  onLongPress: () => void;
}

function shortStatusLabel(status: UploadStatus): string {
  switch (status) {
    case UploadStatus.Completed:
    case UploadStatus.Deduplicated:
      return 'Synced';
    case UploadStatus.Uploading:
    case UploadStatus.Uploaded:
    case UploadStatus.Processing:
    case UploadStatus.Retrying:
      return 'Uploading';
    case UploadStatus.Failed:
      return 'Failed';
    default:
      return 'Pending';
  }
}

function thumbnailUri(file: FileEntity): string | null {
  const candidates = Object.values(file.thumbnails ?? {}).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (candidates.length > 0) {
    return candidates[0];
  }
  return file.mimeType.toLowerCase().startsWith('image/') ? file.filePath : null;
}

/**
 * Square Gallery tile from mockup 9.2: cover thumbnail (or icon fallback),
 * video play overlay, per-status badge, selection check and favorite marker.
 */
export function MediaTile({ file, selected, favorite, onPress, onLongPress }: MediaTileProps) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const [uri, setUri] = useState<string | null>(() => thumbnailUri(file));

  // The local path can change when a scan re-discovers the same content.
  useEffect(() => {
    setUri(thumbnailUri(file));
    setFailed(false);
  }, [file.filePath, file.thumbnails]);

  const isVideo = file.mimeType.toLowerCase().startsWith('video/');
  const showImage = uri !== null && !failed;
  const statusColor = uploadStatusColor(file.status);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.fileName}, ${shortStatusLabel(file.status)}${
        favorite ? ', favorite' : ''
      }`}
      accessibilityState={{ selected }}
      accessibilityHint="Tap for actions, long press to select"
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      style={({ pressed }) => [
        styles.tile,
        { backgroundColor: colors.card, borderColor: selected ? colors.primarySolid : colors.border },
        selected ? styles.selected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      {showImage ? (
        <Image
          source={{ uri: uri }}
          style={styles.thumbnail}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={[styles.fallback, { backgroundColor: colors.secondarySurface }]}>
          <Ionicons
            name={
              uploadStatusIcon(file.status) as React.ComponentProps<typeof Ionicons>['name']
            }
            size={28}
            color={colors.textMuted}
          />
        </View>
      )}

      {isVideo ? (
        <View style={styles.videoOverlay} pointerEvents="none">
          <View style={styles.playCircle}>
            <Ionicons name="play" size={16} color="#FFFFFF" />
          </View>
        </View>
      ) : null}

      {favorite ? (
        <View style={styles.favoriteMarker} pointerEvents="none">
          <Ionicons name="heart" size={12} color="#FFFFFF" />
        </View>
      ) : null}

      <View style={[styles.statusBadge, { backgroundColor: statusColor }]} pointerEvents="none">
        <Text numberOfLines={1} style={styles.statusLabel}>
          {shortStatusLabel(file.status)}
        </Text>
      </View>

      {selected ? (
        <View style={[styles.check, { backgroundColor: colors.primarySolid }]} pointerEvents="none">
          <Ionicons name="checkmark" size={14} color="#FFFFFF" />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
  },
  selected: {
    borderWidth: 3,
  },
  pressed: {
    opacity: 0.85,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  favoriteMarker: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(214,0,170,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusBadge: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    right: 6,
    paddingVertical: 2,
    paddingHorizontal: 5,
    borderRadius: 4,
  },
  statusLabel: {
    color: '#FFFFFF',
    fontFamily: FONT_FAMILY,
    fontSize: 9,
  },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
