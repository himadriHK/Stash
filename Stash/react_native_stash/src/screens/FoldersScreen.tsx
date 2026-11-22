/**
 * Folders screen: list of folder configurations with enable switches, add
 * dialog, per-folder actions (scan now, delete), and an add FAB. Mirrors the
 * documented Folders behaviour of Stash.Maui.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { AddFolderDialog } from '../components/AddFolderDialog';
import { EmptyState } from '../components/EmptyState';
import { FolderDetailsDialog } from '../components/FolderDetailsDialog';
import { NoteText, ScreenTitle } from '../components/FormText';
import { FolderRow } from '../components/FolderRow';
import { useToast } from '../components/ToastContext';
import { useAuth } from '../auth/AuthContext';
import { createFolderConfig, type FolderConfig } from '../models/folderConfig';
import { folderRepository } from '../services/singletons';
import type { FolderIngestionProgress } from '../services/folderIngestionService';
import { scanFolderAsync } from '../services/uploadActions';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import { requestStorageAccessAsync } from '../utils/storagePermissions';

interface FolderScanOptions {
  includePatterns?: string[];
  excludePatterns?: string[];
  includeSubfolders?: boolean;
}

export function FoldersScreen() {
  const { colors } = useTheme();
  const { status } = useAuth();
  const toast = useToast();
  const [folders, setFolders] = useState<FolderConfig[] | null>(null);
  const [dialogVisible, setDialogVisible] = useState(false);
  const [detailsFolder, setDetailsFolder] = useState<FolderConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanProgress, setScanProgress] = useState<FolderIngestionProgress | null>(null);

  const load = useCallback(async () => {
    try {
      setFolders(await folderRepository.getAllAsync());
    } catch (error) {
      console.warn('Failed to load folders.', error);
      setFolders([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onAdd = useCallback(
    async (folderPath: string, folderName?: string, options?: FolderScanOptions) => {
      setDialogVisible(false);
      try {
        if (Platform.OS === 'android' && !folderPath.startsWith('content://')) {
          const access = await requestStorageAccessAsync();
          if (access.state !== 'granted') {
            toast.show(access.detail, { color: colors.error });
            return;
          }
        }

        const existing = await folderRepository.getByPathAsync(folderPath);
        if (existing) {
          toast.show('This folder is already configured.');
          return;
        }
        await folderRepository.addAsync(
          createFolderConfig({
            folderPath,
            folderName,
            includePatterns: options?.includePatterns,
            excludePatterns: options?.excludePatterns,
            includeSubfolders: options?.includeSubfolders,
          }),
        );
        toast.show('Folder added successfully');
        await load();
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      }
    },
    [toast, colors.error, load],
  );

  const onToggle = useCallback(
    async (folder: FolderConfig, enabled: boolean) => {
      try {
        const updated = { ...folder, isEnabled: enabled };
        await folderRepository.updateAsync(updated);
        setFolders((current) =>
          current ? current.map((item) => (item.id === folder.id ? updated : item)) : current,
        );
        toast.show(`${folder.folderName} ${enabled ? 'enabled' : 'disabled'}`);
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      }
    },
    [toast, colors.error],
  );

  const onScanNow = useCallback(
    async (folder: FolderConfig) => {
      if (status !== 'authenticated') {
        toast.show('Sign in to scan folders.', { color: colors.error });
        return;
      }
      if (busy) {
        return;
      }
      setBusy(true);
      setScanProgress({ processed: 0, total: 0 });
      toast.show(`Scanning ${folder.folderName}…`);
      try {
        const result = await scanFolderAsync(folder, (progress) =>
          setScanProgress(progress),
        );
        toast.show(`Scanned ${result.scanned} files, ${result.discovered} new`);
        await load();
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      } finally {
        setBusy(false);
        setScanProgress(null);
      }
    },
    [status, busy, toast, colors.error, load],
  );

  const onDelete = useCallback(
    async (folder: FolderConfig) => {
      try {
        await folderRepository.deleteAsync(folder.id);
        setDetailsFolder(null);
        toast.show('Folder deleted');
        await load();
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      }
    },
    [toast, colors.error, load],
  );

  const onToggleSubfolders = useCallback(
    async (folder: FolderConfig, includeSubfolders: boolean) => {
      try {
        const updated = { ...folder, includeSubfolders };
        await folderRepository.updateAsync(updated);
        setDetailsFolder(updated);
        await load();
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      }
    },
    [toast, colors.error, load],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenTitle>Folders</ScreenTitle>
      <NoteText style={styles.folderNote}>
        {Platform.OS === 'web'
          ? 'Folder scanning is not available in the browser. Use Upload → Pick Files.'
          : 'Folders are added with the system picker. On iOS, access lasts for the current session and must be re-selected after the app restarts.'}
      </NoteText>

      {scanProgress ? (
        <View style={[styles.scanRow, { backgroundColor: colors.card }]}>
          <ActivityIndicator size="small" color={colors.primarySolid} />
          <Text style={[styles.scanLabel, { color: colors.text }]} numberOfLines={1}>
            {scanProgress.total > 0
              ? `Scanning ${scanProgress.processed}/${scanProgress.total}`
              : 'Scanning…'}
          </Text>
        </View>
      ) : null}

      {folders === null ? (
        <EmptyState icon="folder-outline" title="Loading…" subtitle="" />
      ) : folders.length === 0 ? (
        <EmptyState
          icon="folder-open-outline"
          title="No folders added"
          subtitle="Add folders to scan for media files"
          buttonLabel="Add Folder"
          onButtonPress={() => setDialogVisible(true)}
        />
      ) : (
        <FlatList
          data={folders}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <FolderRow folder={item} onPress={setDetailsFolder} onToggle={onToggle} />
          )}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* Floating action button: add folder. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add folder"
        onPress={() => setDialogVisible(true)}
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: colors.primarySolid },
          pressed ? styles.fabPressed : null,
        ]}
      >
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </Pressable>

      <AddFolderDialog
        visible={dialogVisible}
        onCancel={() => setDialogVisible(false)}
        onAdd={(path, name, options) => void onAdd(path, name, options)}
      />

      <FolderDetailsDialog
        visible={detailsFolder !== null}
        folder={detailsFolder}
        onClose={() => setDetailsFolder(null)}
        onScan={(folder) => void onScanNow(folder)}
        onDelete={(folder) => void onDelete(folder)}
        onToggleSubfolders={(folder, value) => void onToggleSubfolders(folder, value)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  folderNote: {
    marginHorizontal: 16,
    marginBottom: 8,
  },
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  scanLabel: {
    flex: 1,
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
  },
  listContent: {
    paddingBottom: 96,
  },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  fabPressed: {
    opacity: 0.85,
  },
});
