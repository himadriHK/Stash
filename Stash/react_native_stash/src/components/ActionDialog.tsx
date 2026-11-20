import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';

export interface ActionDialogButton {
  label: string;
  onPress?: () => void;
  style?: 'default' | 'destructive' | 'cancel';
}

interface ActionDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  buttons: ActionDialogButton[];
  onClose: () => void;
}

/**
 * Cross-platform confirmation/menu dialog (Alert.alert has no button support
 * on web, so menus and confirmations use this instead).
 */
export function ActionDialog({ visible, title, message, buttons, onClose }: ActionDialogProps) {
  const { colors } = useTheme();

  const handlePress = (button: ActionDialogButton) => {
    onClose();
    button.onPress?.();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.card, { backgroundColor: colors.card }]} onPress={(e) => e.stopPropagation()}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          {message ? <Text style={[styles.message, { color: colors.textMuted }]}>{message}</Text> : null}
          <View style={styles.buttonList}>
            {buttons.map((button) => {
              const color =
                button.style === 'destructive'
                  ? colors.error
                  : button.style === 'cancel'
                    ? colors.textMuted
                    : colors.link;
              return (
                <Pressable
                  key={button.label}
                  accessibilityRole="button"
                  onPress={() => handlePress(button)}
                  style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
                >
                  <Text style={[styles.buttonLabel, { color }]}>{button.label}</Text>
                </Pressable>
              );
            })}
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
    maxWidth: 400,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    padding: 20,
  },
  title: {
    fontFamily: FONT_FAMILY,
    fontSize: 18,
    marginBottom: 8,
  },
  message: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    lineHeight: 20,
    marginBottom: 8,
  },
  buttonList: {
    marginTop: 8,
  },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    textAlign: 'center',
  },
});
