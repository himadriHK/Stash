import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ActionDialog } from '../components/ActionDialog';
import { EmptyState } from '../components/EmptyState';
import { FileCard } from '../components/FileCard';
import { ScreenTitle } from '../components/FormText';
import { useToast } from '../components/ToastContext';
import { useSyncProgress } from '../hooks/useSyncProgress';
import { useAuth } from '../auth/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { fileRepository, backgroundUploadService } from '../services/singletons';
import { uploadAndPublishAsync } from '../services/uploadActions';
import type { FileEntity } from '../models/fileEntity';
import { UploadStatus, uploadStatusDisplayName } from '../models/uploadStatus';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import { formatFileSize, formatDate } from '../utils/format';

type Props = NativeStackNavigationProp<RootStackParamList>;

const PAGE_SIZE = 50;

/**
 * Files screen: card list with status chips, error lines, retry/details menu,
 * empty state CTA, and pull-to-refresh that runs a background upload pass
 * (scan -> upload -> Kafka publish) before reloading.
 */
export function FilesScreen() {
  const { colors } = useTheme();
  const { status } = useAuth();
  const toast = useToast();
  const navigation = useNavigation<Props>();
  const { label: syncLabel } = useSyncProgress();

  const [files, setFiles] = useState<FileEntity[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [menuFile, setMenuFile] = useState<FileEntity | null>(null);
  const [detailsFile, setDetailsFile] = useState<FileEntity | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const filesRef = useRef<FileEntity[] | null>(null);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const passRef = useRef(false);

  /**
   * Loads one page. `reset` restarts at offset 0 (focus, refresh, retry);
   * otherwise the next page is appended and de-duplicated by row id.
   */
  const loadPage = useCallback(async (reset: boolean) => {
    if (!reset && (loadingMoreRef.current || !hasMoreRef.current)) {
      return;
    }
    if (!reset) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }

    const offset = reset ? 0 : filesRef.current?.length ?? 0;
    try {
      const page = await fileRepository.getPageAsync(PAGE_SIZE, offset);
      setFiles((current) => {
        let next: FileEntity[];
        if (reset || !current) {
          next = page;
        } else {
          const seen = new Set(current.map((item) => item.id));
          next = [...current, ...page.filter((item) => !seen.has(item.id))];
        }
        filesRef.current = next;
        return next;
      });
      hasMoreRef.current = page.length === PAGE_SIZE;
      setHasMore(hasMoreRef.current);
    } catch (error) {
      console.warn('Failed to load files.', error);
      if (reset) {
        filesRef.current = [];
        setFiles([]);
      }
    } finally {
      if (!reset) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadPage(true);
    }, [loadPage]),
  );

  /**
   * Pull-to-refresh reloads the list, then kicks off the upload pass without
   * waiting for it. The pass can take minutes on a large library; awaiting it
   * here would freeze the refresh gesture while the JS thread is busy, so the
   * pass reports progress through the sync banner instead.
   */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadPage(true);
    } finally {
      setRefreshing(false);
    }

    if (status !== 'authenticated' || passRef.current) {
      return;
    }

    passRef.current = true;
    try {
      const result = await backgroundUploadService.runOnceAsync();
      if (result.success) {
        toast.show(
          `Upload pass: ${result.scanned} scanned, ${result.discovered} new, ` +
            `${result.uploaded} uploaded, ${result.queued} queued`,
        );
      } else if (!result.alreadyRunning) {
        toast.show(result.error ?? 'Background upload pass failed.', { color: colors.error });
      }
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    } finally {
      passRef.current = false;
      await loadPage(true);
    }
  }, [status, toast, colors.error, loadPage]);

  const onRetry = useCallback(
    async (file: FileEntity) => {
      if (retrying) {
        return;
      }
      setRetrying(true);
      toast.show(`Retrying upload: ${file.fileName}`);
      try {
        const fresh = await fileRepository.getByIdAsync(file.id);
        if (!fresh) {
          await loadPage(true);
          return;
        }
        const outcome = await uploadAndPublishAsync(fresh);
        if (outcome.queued) {
          toast.show(`Upload queued: ${file.fileName}`);
        } else {
          toast.show(outcome.error ?? 'Upload failed.', { color: colors.error });
        }
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      } finally {
        setRetrying(false);
        await loadPage(true);
      }
    },
    [retrying, toast, colors.error, loadPage],
  );

  const menuNeedsRetry =
    menuFile?.status === UploadStatus.Failed || menuFile?.status === UploadStatus.Retrying;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenTitle>Files</ScreenTitle>

      {syncLabel ? (
        <View style={[styles.syncRow, { backgroundColor: colors.card }]}>
          <ActivityIndicator size="small" color={colors.primarySolid} />
          <Text style={[styles.syncLabel, { color: colors.text }]} numberOfLines={1}>
            {syncLabel}
          </Text>
        </View>
      ) : null}

      {files === null ? (
        <EmptyState icon="document-text-outline" title="Loading…" subtitle="" />
      ) : files.length === 0 ? (
        <EmptyState
          icon="file-tray-outline"
          title="No files found"
          subtitle="Add folders to scan for media files"
          buttonLabel="Add Folders"
          onButtonPress={() => navigation.navigate('Main', { screen: 'Folders' })}
        />
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <FileCard file={item} onPress={setDetailsFile} onMorePress={setMenuFile} />
          )}
          contentContainerStyle={styles.listContent}
          onEndReached={() => {
            if (hasMore) {
              void loadPage(false);
            }
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={styles.footer} color={colors.primarySolid} />
            ) : undefined
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primarySolid} />
          }
        />
      )}

      {/* Floating action button: upload new files (documented FAB behaviour). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Upload files"
        onPress={() => navigation.navigate('Main', { screen: 'Upload' })}
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: colors.primarySolid },
          pressed ? styles.fabPressed : null,
        ]}
      >
        <Ionicons name="cloud-upload-outline" size={26} color="#FFFFFF" />
      </Pressable>

      <ActionDialog
        visible={menuFile !== null}
        title={menuFile?.fileName ?? ''}
        buttons={[
          ...(menuNeedsRetry && menuFile
            ? [{ label: 'Retry upload', onPress: () => void onRetry(menuFile) }]
            : []),
          { label: 'Details', onPress: () => setDetailsFile(menuFile) },
          { label: 'Close', style: 'cancel' as const },
        ]}
        onClose={() => setMenuFile(null)}
      />

      <ActionDialog
        visible={detailsFile !== null}
        title={detailsFile?.fileName ?? ''}
        message={
          detailsFile
            ? [
                `Path: ${detailsFile.filePath}`,
                `Size: ${formatFileSize(detailsFile.fileSize)}`,
                `Status: ${uploadStatusDisplayName(detailsFile.status)}`,
                `MIME type: ${detailsFile.mimeType}`,
                `Content hash: ${detailsFile.contentHash}`,
                `Retries: ${detailsFile.retryCount}`,
                `Storage temp path: ${detailsFile.storageTempPath ?? '—'}`,
                `Permanent path: ${detailsFile.permanentPath ?? '—'}`,
                `Device ID: ${detailsFile.deviceId || '—'}`,
                `Last attempt: ${formatDate(detailsFile.lastAttemptAt)}`,
                ...(detailsFile.errorMessage ? [`Error: ${detailsFile.errorMessage}`] : []),
              ].join('\n')
            : ''
        }
        buttons={[{ label: 'Close', style: 'cancel' as const }]}
        onClose={() => setDetailsFile(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 96,
  },
  footer: {
    paddingVertical: 16,
  },
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  syncLabel: {
    flex: 1,
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
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
