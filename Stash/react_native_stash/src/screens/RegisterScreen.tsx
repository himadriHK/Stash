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
import { ErrorText, Headline, SubHeadline } from '../components/FormText';
import { FormInput } from '../components/FormInput';
import { useAuth } from '../auth/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { useTheme } from '../theme/ThemeContext';
import { layout } from '../theme/typography';

type Props = NativeStackScreenProps<RootStackParamList, 'Register'>;

/**
 * Register screen matching Stash.Maui/Views/RegisterPage.xaml with the
 * documented validation: passwords match, minimum 8 characters, device ID
 * required. Registration signs the user in immediately (the Identity API
 * returns a token pair from /api/auth/register).
 */
export function RegisterScreen({ navigation }: Props) {
  const { register, deviceId } = useAuth();
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [deviceIdInput, setDeviceIdInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (deviceId && !initializedRef.current && !deviceIdInput) {
      initializedRef.current = true;
      setDeviceIdInput(deviceId);
    }
  }, [deviceId, deviceIdInput]);

  const onCreateAccount = async () => {
    if (busy) {
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters.');
      return;
    }

    setBusy(true);
    setErrorMessage(null);
    try {
      if (!deviceIdInput.trim()) {
        setErrorMessage('A device ID is required.');
        return;
      }

      const result = await register(email, password, deviceIdInput);
      if (!result.isSuccess) {
        setErrorMessage(result.error ?? 'Registration failed.');
        return;
      }

      setPassword('');
      setConfirmPassword('');
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
          <Headline>Create account</Headline>
          <SubHeadline>Register this device for Stash backups</SubHeadline>

          <FormInput
            testID="RegisterEmailEntry"
            placeholder="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />

          <FormInput
            testID="RegisterPasswordEntry"
            placeholder="Password (minimum 8 characters)"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            editable={!busy}
          />

          <FormInput
            testID="RegisterConfirmPasswordEntry"
            placeholder="Confirm password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            editable={!busy}
          />

          <FormInput
            testID="RegisterDeviceIdEntry"
            placeholder="Device ID"
            value={deviceIdInput}
            onChangeText={setDeviceIdInput}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />

          <ErrorText testID="RegisterErrorLabel">{errorMessage}</ErrorText>

          {busy ? (
            <ActivityIndicator
              color={colors.indicator}
              style={styles.indicator}
              accessibilityLabel="Creating account"
            />
          ) : null}

          <AppButton
            title="Create account"
            onPress={onCreateAccount}
            disabled={busy}
            testID="RegisterButton"
          />

          <AppButton
            title="Back to sign in"
            variant="link"
            onPress={() => navigation.goBack()}
            disabled={busy}
            testID="BackToLoginButton"
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
