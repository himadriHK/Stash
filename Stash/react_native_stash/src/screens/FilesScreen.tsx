import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
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
import { useAuth } from '../auth/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { fileRepository, backgroundUploadService } from '../services/singletons';
import { uploadAndPublishAsync } from '../services/uploadActions';
import type { FileEntity } from '../models/fileEntity';
import { UploadStatus, uploadStatusDisplayName } from '../models/uploadStatus';
import { useTheme } from '../theme/ThemeContext';
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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (status === 'authenticated') {
        const result = await backgroundUploadService.runOnceAsync();
        if (result.success) {
          toast.show(
            `Upload pass: ${result.scanned} scanned, ${result.discovered} new, ` +
              `${result.uploaded} uploaded, ${result.queued} queued`,
          );
        } else {
          toast.show(result.error ?? 'Background upload pass failed.', { color: colors.error });
        }
      }
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    } finally {
      await loadPage(true);
      setRefreshing(false);
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
