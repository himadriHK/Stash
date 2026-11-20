import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { AppButton } from '../components/AppButton';
import { ErrorText, Headline, NoteText, SubHeadline } from '../components/FormText';
import { FormInput } from '../components/FormInput';
import { useAuth } from '../auth/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { useTheme } from '../theme/ThemeContext';
import { layout } from '../theme/typography';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

/**
 * Login screen matching Stash.Maui/Views/LoginPage.xaml: centered 480px-max
 * form, spacing 14, device-ID note, #B00020 error label, busy indicator, and
 * primary/link buttons (disabled while busy).
 */
export function LoginScreen({ navigation }: Props) {
  const { login, deviceId } = useAuth();
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [deviceIdInput, setDeviceIdInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // Device ID is prefilled from secure storage on first display.
  useEffect(() => {
    if (deviceId && !initializedRef.current && !deviceIdInput) {
      initializedRef.current = true;
      setDeviceIdInput(deviceId);
    }
  }, [deviceId, deviceIdInput]);

  const onSignIn = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      if (!deviceIdInput.trim()) {
        setErrorMessage('A device ID is required.');
        return;
      }

      const result = await login(email, password, deviceIdInput);
      if (!result.isSuccess) {
        setErrorMessage(result.error ?? 'Login failed.');
        return;
      }

      setPassword('');
      // AuthContext flips to authenticated; RootNavigator swaps in Main.
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.form}>
          <Headline>Stash</Headline>
          <SubHeadline>Sign in to your backup account</SubHeadline>

          <FormInput
            testID="LoginEmailEntry"
            placeholder="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />

          <FormInput
            testID="LoginPasswordEntry"
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            editable={!busy}
          />

          <FormInput
            testID="LoginDeviceIdEntry"
            placeholder="Device ID"
            value={deviceIdInput}
            onChangeText={setDeviceIdInput}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />

          <NoteText>
            The device ID identifies this installation. It is generated automatically and can be
            left unchanged.
          </NoteText>

          <ErrorText testID="LoginErrorLabel">{errorMessage}</ErrorText>

          {busy ? (
            <ActivityIndicator
              color={colors.indicator}
              style={styles.indicator}
              accessibilityLabel="Signing in"
            />
          ) : null}

          <AppButton title="Sign in" onPress={onSignIn} disabled={busy} testID="LoginButton" />

          <AppButton
            title="Create account"
            variant="link"
            onPress={() => navigation.navigate('Register')}
            disabled={busy}
            testID="GoToRegisterButton"
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  form: {
    width: '100%',
    maxWidth: layout.formMaxWidth,
    alignSelf: 'center',
    paddingHorizontal: layout.formPaddingHorizontal,
    paddingVertical: layout.formPaddingVertical,
    gap: layout.formSpacing,
  },
  indicator: {
    alignSelf: 'center',
  },
});
