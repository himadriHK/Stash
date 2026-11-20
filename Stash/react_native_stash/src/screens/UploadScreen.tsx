/**
 * Upload screen: pick media files (document picker), flag oversize files,
 * hash + dedup into SQLite, then batch upload to Mega and publish Kafka upload
 * requests. Mirrors the documented manual-upload workflow.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import { AppButton } from '../components/AppButton';
import { EmptyState } from '../components/EmptyState';
import { NoteText, ScreenTitle } from '../components/FormText';
import { useToast } from '../components/ToastContext';
import { useAuth } from '../auth/AuthContext';
import { appConfig } from '../config/appConfig';
import { fileRepository, folderScanner } from '../services/singletons';
import { uploadBatchAndPublishAsync } from '../services/uploadActions';
import { createFileEntity } from '../models/fileEntity';
import { UploadStatus } from '../models/uploadStatus';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import { formatBytesAsMb, formatFileSize } from '../utils/format';
import { mimeTypeForFile } from '../services/folderScannerService';

interface PickedFile {
  uri: string;
  name: string;
  size: number;
}

const PICKER_TYPES = ['image/*', 'video/*'];

export function UploadScreen() {
  const { colors } = useTheme();
  const { status } = useAuth();
  const toast = useToast();
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);

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

  const uploadPicked = useCallback(async () => {
    if (busy || picked.length === 0) {
      return;
    }
    if (status !== 'authenticated') {
      toast.show('Sign in to upload files.', { color: colors.error });
      return;
    }
    setBusy(true);
    let skipped = 0;
    try {
      const entities = [];
      let hashFailed = 0;
      for (const file of picked) {
        const hash = await folderScanner.computeFileHashAsync(file.uri, file.size);
        if (!hash) {
          hashFailed += 1;
          continue;
        }
        if (await fileRepository.existsByContentHashAsync(hash)) {
          skipped += 1;
          continue;
        }
        const entity = createFileEntity({
          fileName: file.name,
          filePath: file.uri,
          fileSize: file.size,
          contentHash: hash,
          mimeType: mimeTypeForFile(file.name),
          status: UploadStatus.Pending,
        });
        await fileRepository.addAsync(entity);
        entities.push(entity);
      }

      let uploaded = 0;
      let queued = 0;
      let failed = hashFailed;
      if (entities.length > 0) {
        const outcome = await uploadBatchAndPublishAsync(entities);
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
      setBusy(false);
    }
  }, [busy, picked, status, toast, colors.error]);

  // Clear stale selections when leaving the screen? Keep them; they remain
  // valid cache URIs for this session.

  const oversizeCount = picked.filter((file) => file.size > maxFileSize).length;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenTitle>Upload</ScreenTitle>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {picked.length === 0 ? (
          <EmptyState
            icon="cloud-upload-outline"
            title="No files selected"
            subtitle="Pick media files to upload to Mega storage"
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

        <NoteText style={styles.limitNote}>
          Maximum file size {formatBytesAsMb(maxFileSize)}. Files are hashed locally and
          deduplicated before upload; duplicates are skipped.
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
  limitNote: {
    marginTop: 16,
    marginHorizontal: 16,
    textAlign: 'center',
  },
});
