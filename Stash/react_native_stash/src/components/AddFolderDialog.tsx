import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes, layout } from '../theme/typography';

interface AddFolderDialogProps {
  visible: boolean;
  onCancel: () => void;
  onAdd: (folderPath: string) => void;
}

/**
 * Add-folder dialog documented in the UI docs: path input (label "Folder
 * Path", hint "Select folder path") with Cancel / Add actions.
 */
export function AddFolderDialog({ visible, onCancel, onAdd }: AddFolderDialogProps) {
  const { colors } = useTheme();
  const [path, setPath] = useState('');

  useEffect(() => {
    if (visible) {
      setPath('');
    }
  }, [visible]);

  const canAdd = path.trim().length > 0;

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

            <Text style={[styles.label, { color: colors.textMuted }]}>Folder Path</Text>
            <TextInput
              value={path}
              onChangeText={setPath}
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
                onPress={() => onAdd(path.trim())}
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
