/**
 * Upload screen: pick media files (document picker), flag oversize files,
 * dedup by metadata (name + size) into SQLite, then batch upload to S3 and
 * publish Kafka upload requests. Mirrors the documented manual-upload workflow.
 */
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { AppButton } from '../components/AppButton';
import { EmptyState } from '../components/EmptyState';
import { NoteText, ScreenTitle } from '../components/FormText';
import { useToast } from '../components/ToastContext';
import { useAuth } from '../auth/AuthContext';
import { appConfig } from '../config/appConfig';
import { fileRepository } from '../services/singletons';
import { uploadBatchAndPublishAsync } from '../services/uploadActions';
import { createFileEntity, type FileEntity } from '../models/fileEntity';
import { UploadStatus } from '../models/uploadStatus';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import { formatBytesAsMb, formatFileSize } from '../utils/format';
import { mimeTypeForFile } from '../services/folderScannerService';
import { forEachChunkedAsync } from '../utils/cooperative';
import { computeMetadataHash } from '../utils/fileIdentity';

interface PickedFile {
  uri: string;
  name: string;
  size: number;
}

const PICKER_TYPES = ['image/*', 'video/*'];
/** Picked files prepared per scheduling slice. */
const UPLOAD_PREPARE_CHUNK_SIZE = 10;
/** Rows inserted per transaction (29 bound parameters per row). */
const FILE_INSERT_BATCH_SIZE = 25;
/** Minimum gap between progress label updates. */
const PROGRESS_INTERVAL_MS = 200;

/** Friendly label for a batch pipeline phase. */
function batchPhaseLabel(phase: 'ownership' | 'uploading' | 'publishing'): string {
  switch (phase) {
    case 'ownership':
      return 'Preparing';
    case 'publishing':
      return 'Queuing';
    default:
      return 'Uploading';
  }
}

export function UploadScreen() {
  const { colors } = useTheme();
  const { status } = useAuth();
  const toast = useToast();
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const maxFileSize = appConfig.UploadSettings.MaxFileSizeBytes;

  const pickFiles = useCallback(async () => {
    if (busy) {
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: PICKER_TYPES,
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }
      const next: PickedFile[] = result.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.name ?? 'file',
        size: asset.size ?? 0,
      }));
      setPicked((current) => {
        const seen = new Set(current.map((file) => `${file.uri}|${file.name}|${file.size}`));
        return [...current, ...next.filter((file) => !seen.has(`${file.uri}|${file.name}|${file.size}`))];
      });
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    }
  }, [busy, toast, colors.error]);

  const lastProgressAtRef = useRef(0);

  /**
   * Progress updates arrive once per file; throttle them so a 10k-file run does
   * not trigger a React render per file.
   */
  const reportProgress = useCallback((text: string) => {
    const now = Date.now();
    if (now - lastProgressAtRef.current < PROGRESS_INTERVAL_MS) {
      return;
    }
    lastProgressAtRef.current = now;
    setProgress(text);
  }, []);

  const uploadPicked = useCallback(async () => {
    if (busy || picked.length === 0) {
      return;
    }
    if (status !== 'authenticated') {
      toast.show('Sign in to upload files.', { color: colors.error });
      return;
    }
    setBusy(true);
    lastProgressAtRef.current = 0;
    setProgress(`Preparing 0/${picked.length}`);
    let skipped = 0;
    try {
      // Deduplication reads one snapshot of tracked metadata identities instead
      // of one query per picked file, then inserts in transactional batches. No
      // file bytes are read: identity is the name plus the byte size.
      const knownMetadata = await fileRepository.getAllMetadataHashesAsync();
      const entities: FileEntity[] = [];

      await forEachChunkedAsync(
        picked,
        async (chunk) => {
          for (const file of chunk) {
            const metadataHash = await computeMetadataHash(file.name, file.size);
            if (knownMetadata.has(metadataHash)) {
              skipped += 1;
              continue;
            }
            knownMetadata.add(metadataHash);
            entities.push(
              createFileEntity({
                fileName: file.name,
                filePath: file.uri,
                fileSize: file.size,
                metadataHash,
                mimeType: mimeTypeForFile(file.name),
                status: UploadStatus.Pending,
              }),
            );
          }
        },
        {
          chunkSize: UPLOAD_PREPARE_CHUNK_SIZE,
          onProgress: (processed, total) => reportProgress(`Preparing ${processed}/${total}`),
        },
      );

      if (entities.length > 0) {
        setProgress(`Saving 0/${entities.length}`);
        await forEachChunkedAsync(
          entities,
          async (chunk) => {
            await fileRepository.addManyAsync(chunk);
          },
          {
            chunkSize: FILE_INSERT_BATCH_SIZE,
            onProgress: (processed, total) => reportProgress(`Saving ${processed}/${total}`),
          },
        );
      }

      let uploaded = 0;
      let queued = 0;
      let failed = 0;
      if (entities.length > 0) {
        const outcome = await uploadBatchAndPublishAsync(entities, (update) => {
          reportProgress(
            `${batchPhaseLabel(update.phase)} ${update.processed}/${update.total}`,
          );
        });
        uploaded = outcome.uploaded;
        queued = outcome.queued;
        failed += outcome.failed;
      }

      const parts = [`Uploaded: ${uploaded}`, `Queued: ${queued}`, `Failed: ${failed}`];
      if (skipped > 0) {
        parts.push(`Duplicates skipped: ${skipped}`);
      }
      toast.show(parts.join(', '), failed > 0 ? { color: colors.error } : undefined);
      setPicked([]);
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }, [busy, picked, status, toast, colors.error, reportProgress]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenTitle>Upload</ScreenTitle>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {picked.length === 0 ? (
          <EmptyState
            icon="cloud-upload-outline"
            title="No files selected"
            subtitle="Pick media files to upload to S3 storage"
          />
        ) : (
          picked.map((file) => {
            const oversize = file.size > maxFileSize;
            return (
              <View
                key={`${file.uri}|${file.name}`}
                style={[styles.fileRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <Ionicons
                  name={oversize ? 'alert-circle-outline' : 'document-outline'}
                  size={22}
                  color={oversize ? colors.error : colors.textMuted}
                />
                <View style={styles.fileBody}>
                  <Text numberOfLines={1} style={[styles.fileName, { color: colors.text }]}>
                    {file.name}
                  </Text>
                  <Text style={[styles.fileMeta, { color: colors.textMuted }]}>
                    {formatFileSize(file.size)}
                  </Text>
                  {oversize ? (
                    <Text style={[styles.fileMeta, styles.oversize, { color: colors.error }]}>
                      Exceeds {formatBytesAsMb(maxFileSize)} limit
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${file.name}`}
                  hitSlop={8}
                  onPress={() =>
                    setPicked((current) => current.filter((item) => item.uri !== file.uri || item.name !== file.name))
                  }
                  disabled={busy}
                >
                  <Ionicons name="close-circle" size={20} color={colors.textMuted} />
                </Pressable>
              </View>
            );
          })
        )}

        <View style={styles.actions}>
          <AppButton
            title={busy ? 'Uploading…' : 'Upload Files'}
            onPress={uploadPicked}
            disabled={busy || picked.length === 0}
            testID="UploadFilesButton"
          />
          <AppButton
            title="Pick Files"
            variant="link"
            onPress={pickFiles}
            disabled={busy}
            testID="PickFilesButton"
          />
        </View>

        {busy ? (
          <ActivityIndicator color={colors.indicator} style={styles.indicator} />
        ) : null}

        {busy && progress ? (
          <NoteText style={[styles.progressNote, { color: colors.textMuted }]}>{progress}</NoteText>
        ) : null}

        <NoteText style={styles.limitNote}>
          Maximum file size {formatBytesAsMb(maxFileSize)}. Files are deduplicated by name
          and size before upload; the host deduplicates by content. Duplicates are skipped.
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
    flexGrow: 1,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginVertical: 6,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  fileBody: {
    flex: 1,
    marginHorizontal: 12,
  },
  fileName: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  fileMeta: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    marginTop: 2,
  },
  oversize: {
    marginTop: 4,
  },
  actions: {
    marginTop: 16,
    marginHorizontal: 12,
    gap: fontSizes.small,
  },
  indicator: {
    marginTop: 16,
  },
  progressNote: {
    marginTop: 8,
    marginHorizontal: 16,
    textAlign: 'center',
  },
  limitNote: {
    marginTop: 16,
    marginHorizontal: 16,
    textAlign: 'center',
  },
});
