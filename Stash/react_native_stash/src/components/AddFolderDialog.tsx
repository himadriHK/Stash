import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Directory } from 'expo-file-system';
import { folderNameFromPath } from '../models/folderConfig';
import { defaultIncludePatterns } from '../models/mediaPatterns';
import { ErrorText, NoteText } from './FormText';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes, layout } from '../theme/typography';

interface FolderScanOptions {
  includePatterns: string[];
  excludePatterns: string[];
  includeSubfolders: boolean;
}

interface AddFolderDialogProps {
  visible: boolean;
  onCancel: () => void;
  onAdd: (
    folderPath: string,
    folderName?: string,
    options?: FolderScanOptions,
  ) => void | Promise<void>;
}

function parsePatterns(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/**
 * Add-folder dialog documented in the UI docs. Native uses the system folder
 * picker; a manual path field remains for development and legacy paths.
 */
export function AddFolderDialog({ visible, onCancel, onAdd }: AddFolderDialogProps) {
  const { colors } = useTheme();
  const [pickedPath, setPickedPath] = useState('');
  const [pickedName, setPickedName] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerMessage, setPickerMessage] = useState<string | null>(null);
  const [includePatterns, setIncludePatterns] = useState(defaultIncludePatterns.join(', '));
  const [excludePatterns, setExcludePatterns] = useState('');
  const [includeSubfolders, setIncludeSubfolders] = useState(true);

  useEffect(() => {
    if (visible) {
      setPickedPath('');
      setPickedName('');
      setManualPath('');
      setManualMode(false);
      setPicking(false);
      setError(null);
      setPickerMessage(null);
      setIncludePatterns(defaultIncludePatterns.join(', '));
      setExcludePatterns('');
      setIncludeSubfolders(true);
    }
  }, [visible]);

  const selectFolder = useCallback(async () => {
    if (Platform.OS === 'web' || picking) {
      return;
    }
    setPicking(true);
    setError(null);
    setPickerMessage(null);
    try {
      const directory = await Directory.pickDirectoryAsync();
      setPickedPath(directory.uri);
      setPickedName(directory.name);
    } catch (pickerError) {
      const message = pickerError instanceof Error ? pickerError.message : String(pickerError);
      if (/cancel/i.test(message)) {
        setPickerMessage('Folder selection cancelled.');
      } else {
        setError(message);
      }
    } finally {
      setPicking(false);
    }
  }, [picking]);

  const effectivePath = manualMode ? manualPath.trim() : pickedPath;
  const effectiveName = manualMode ? folderNameFromPath(effectivePath) : pickedName;
  const canAdd = effectivePath.length > 0;
  const displayUri =
    pickedPath.length > 64 ? `${pickedPath.slice(0, 61)}…` : pickedPath;
  const webUnavailable = Platform.OS === 'web';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <Pressable style={styles.backdrop} onPress={onCancel}>
          <Pressable
            style={[styles.card, { backgroundColor: colors.card }]}
            onPress={(event) => event.stopPropagation()}
          >
            <Text style={[styles.title, { color: colors.text }]}>Add Folder</Text>

            {webUnavailable ? (
              <NoteText style={styles.webNote}>
                Folder scanning is not available in the browser. Use Upload → Pick Files.
              </NoteText>
            ) : null}

            {!manualMode ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Choose Folder"
                  disabled={webUnavailable || picking}
                  onPress={() => void selectFolder()}
                  style={({ pressed }) => [
                    styles.pickButton,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                      opacity: webUnavailable ? 0.5 : 1,
                    },
                    pressed ? styles.pressed : null,
                  ]}
                >
                  {picking ? (
                    <ActivityIndicator color={colors.primarySolid} />
                  ) : (
                    <Text style={[styles.pickButtonLabel, { color: colors.text }]}>Choose Folder</Text>
                  )}
                </Pressable>

                {pickedPath ? (
                  <View
                    style={[
                      styles.selection,
                      { borderColor: colors.border, backgroundColor: colors.background },
                    ]}
                  >
                    <Text numberOfLines={1} style={[styles.selectionName, { color: colors.text }]}>
                      {pickedName || folderNameFromPath(pickedPath)}
                    </Text>
                    <Text numberOfLines={1} style={[styles.selectionUri, { color: colors.textMuted }]}>
                      {displayUri}
                    </Text>
                  </View>
                ) : null}

                {pickerMessage ? (
                  <NoteText style={styles.message}>{pickerMessage}</NoteText>
                ) : null}
              </>
            ) : (
              <>
                <Text style={[styles.label, { color: colors.textMuted }]}>Folder Path</Text>
                <TextInput
                  value={manualPath}
                  onChangeText={(value) => {
                    setManualPath(value);
                    setError(null);
                  }}
                  placeholder="Select folder path"
                  placeholderTextColor={colors.placeholder}
                  selectionColor={colors.primarySolid}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.input,
                    {
                      color: colors.inputText,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                />
                <NoteText style={styles.manualNote}>
                  Manual paths are for development and legacy locations. Android may request
                  broad storage access for these paths.
                </NoteText>
              </>
            )}

            {error ? <ErrorText style={styles.error}>{error}</ErrorText> : null}

            <View style={styles.options}>
              <Text style={[styles.label, { color: colors.textMuted }]}>Include Patterns</Text>
              <TextInput
                value={includePatterns}
                onChangeText={setIncludePatterns}
                placeholder="*.jpg, *.png, *.mov"
                placeholderTextColor={colors.placeholder}
                selectionColor={colors.primarySolid}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.input,
                  {
                    color: colors.inputText,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
              />
              <Text style={[styles.label, styles.optionsGap, { color: colors.textMuted }]}>
                Exclude Patterns
              </Text>
              <TextInput
                value={excludePatterns}
                onChangeText={setExcludePatterns}
                placeholder="*.tmp, *.cache"
                placeholderTextColor={colors.placeholder}
                selectionColor={colors.primarySolid}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.input,
                  {
                    color: colors.inputText,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
              />
              <View style={styles.switchRow}>
                <Text style={[styles.switchLabel, { color: colors.text }]}>Include Subfolders</Text>
                <Switch
                  value={includeSubfolders}
                  onValueChange={setIncludeSubfolders}
                  trackColor={{ true: colors.switchTrackOn, false: colors.switchTrackOff }}
                  thumbColor={colors.switchThumb}
                  accessibilityLabel="Include subfolders"
                />
              </View>
            </View>

            {!webUnavailable && !manualMode && Platform.OS === 'ios' ? (
              <NoteText style={styles.message}>
                On iOS, folder access is granted for the current session and must be re-selected
                after the app restarts.
              </NoteText>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setManualMode((current) => !current);
                setError(null);
                setPickerMessage(null);
              }}
              style={({ pressed }) => [styles.linkRow, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.linkLabel, { color: colors.link }]}>
                {manualMode ? 'Use system picker' : 'Enter a path manually'}
              </Text>
            </Pressable>

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={onCancel}
                style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
              >
                <Text style={[styles.actionLabel, { color: colors.link }]}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!canAdd}
                onPress={() =>
                  void onAdd(effectivePath, effectiveName || undefined, {
                    includePatterns: parsePatterns(includePatterns),
                    excludePatterns: parsePatterns(excludePatterns),
                    includeSubfolders,
                  })
                }
                style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
              >
                <Text
                  style={[
                    styles.actionLabel,
                    { color: canAdd ? colors.link : colors.disabledText },
                  ]}
                >
                  Add
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
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
    maxWidth: 400,
    borderRadius: 8,
    padding: 20,
  },
  title: {
    fontFamily: FONT_FAMILY,
    fontSize: 18,
    marginBottom: 12,
  },
  label: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    marginBottom: 6,
  },
  input: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    minHeight: layout.buttonMinHeight,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickButton: {
    minHeight: layout.buttonMinHeight,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  pickButtonLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  selection: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  selectionName: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  selectionUri: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    marginTop: 2,
  },
  webNote: {
    marginBottom: 12,
  },
  message: {
    marginTop: 10,
  },
  manualNote: {
    marginTop: 6,
  },
  options: {
    marginTop: 14,
  },
  optionsGap: {
    marginTop: 10,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    minHeight: 40,
  },
  switchLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  error: {
    marginTop: 10,
  },
  linkRow: {
    alignSelf: 'flex-start',
    marginTop: 12,
    paddingVertical: 4,
  },
  linkLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 8,
  },
  action: {
    minHeight: layout.buttonMinHeight,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  actionLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  pressed: {
    opacity: 0.7,
  },
});