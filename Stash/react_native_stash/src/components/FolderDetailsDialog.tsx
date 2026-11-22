import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { FolderConfig } from '../models/folderConfig';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes, layout } from '../theme/typography';
import { formatDate } from '../utils/format';

interface FolderDetailsDialogProps {
  visible: boolean;
  folder: FolderConfig | null;
  onClose: () => void;
  onToggleSubfolders: (folder: FolderConfig, includeSubfolders: boolean) => void;
  onScan: (folder: FolderConfig) => void;
  onDelete: (folder: FolderConfig) => void;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text selectable style={[styles.rowValue, { color: colors.text }]}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Folder details sheet from mockup 04-folders.html: path, enabled state, last
 * scan, include/exclude patterns and the include-subfolders toggle, with the
 * Scan now / Delete actions kept from the previous action sheet.
 */
export function FolderDetailsDialog({
  visible,
  folder,
  onClose,
  onToggleSubfolders,
  onScan,
  onDelete,
}: FolderDetailsDialogProps) {
  const { colors } = useTheme();
  if (!folder) {
    return null;
  }

  const patterns = (values: string[]) => (values.length > 0 ? values.join(', ') : 'None');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.card, { backgroundColor: colors.card }]}
          onPress={(event) => event.stopPropagation()}
        >
          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
              {folder.folderName}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close folder details"
              hitSlop={8}
              onPress={onClose}
              style={({ pressed }) => [styles.close, pressed ? styles.pressed : null]}
            >
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <DetailRow label="Path" value={folder.folderPath} />
            <DetailRow label="Status" value={folder.isEnabled ? 'Enabled' : 'Disabled'} />
            <DetailRow
              label="Last scanned"
              value={folder.lastScannedAt ? formatDate(folder.lastScannedAt) : 'Never'}
            />
            <DetailRow label="Include patterns" value={patterns(folder.includePatterns)} />
            <DetailRow label="Exclude patterns" value={patterns(folder.excludePatterns)} />

            <View style={[styles.row, { borderBottomColor: colors.border }]}>
              <View style={styles.switchBody}>
                <Text style={[styles.rowLabel, { color: colors.text }]}>Include subfolders</Text>
                <Text style={[styles.hint, { color: colors.textMuted }]}>
                  Scan folders nested inside this folder.
                </Text>
              </View>
              <Switch
                value={folder.includeSubfolders}
                onValueChange={(value) => onToggleSubfolders(folder, value)}
                trackColor={{ true: colors.switchTrackOn, false: colors.switchTrackOff }}
                thumbColor={colors.switchThumb}
                accessibilityLabel="Include subfolders"
              />
            </View>
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => onScan(folder)}
              style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.actionLabel, { color: colors.link }]}>Scan now</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => onDelete(folder)}
              style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.actionLabel, { color: colors.error }]}>Delete</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [
                styles.doneAction,
                { backgroundColor: colors.primarySolid },
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={styles.doneLabel}>Done</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '85%',
    borderRadius: 8,
    padding: 16,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    flex: 1,
    fontFamily: FONT_FAMILY,
    fontSize: 18,
  },
  close: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingBottom: 4,
  },
  row: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 4,
  },
  rowLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  rowValue: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    lineHeight: 18,
  },
  switchBody: {
    flex: 1,
    marginRight: 12,
  },
  hint: {
    fontFamily: FONT_FAMILY,
    fontSize: 11,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 12,
    gap: 8,
  },
  action: {
    minHeight: layout.buttonMinHeight,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  actionLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  doneAction: {
    minHeight: 40,
    borderRadius: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneLabel: {
    color: '#FFFFFF',
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  pressed: {
    opacity: 0.7,
  },
});
