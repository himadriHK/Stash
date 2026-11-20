import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';

interface ToastOptions {
  color?: string;
}

interface ToastContextValue {
  show: (message: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/**
 * Snackbar-style feedback used across the screens (documented SnackBar
 * behaviour: themed surface, auto-dismiss).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  const [color, setColor] = useState(colors.snackbarBg);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (nextMessage: string, options?: ToastOptions) => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
      setColor(options?.color ?? colors.snackbarBg);
      setMessage(nextMessage);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }).start(() => setMessage(null));
      }, 2500);
    },
    [colors.snackbarBg, opacity],
  );

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {message !== null ? (
        <Animated.View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[styles.toast, { backgroundColor: color, opacity }]}
        >
          <Animated.Text style={styles.message}>{message}</Animated.Text>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error('useToast must be used inside a ToastProvider');
  }
  return value;
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    bottom: 90,
    alignSelf: 'center',
    maxWidth: '85%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  message: {
    color: '#FFFFFF',
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    textAlign: 'center',
  },
});
