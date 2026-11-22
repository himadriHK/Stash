/**
 * Root navigator: auth-gated stack. Unauthenticated users get the
 * headerless Login (initial) / Register pair; authenticated users get the
 * Main shell with the "Stash" header and right-side Log out action.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../auth/AuthContext';
import { LoginScreen } from '../screens/LoginScreen';
import { RegisterScreen } from '../screens/RegisterScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { MainTabs } from './MainTabs';
import type { RootStackParamList } from './types';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY } from '../theme/typography';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { status, logout } = useAuth();
  const { colors, dark } = useTheme();

  if (status === 'loading') {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.indicator} />
      </View>
    );
  }

  const navTheme = {
    ...(dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(dark ? DarkTheme.colors : DefaultTheme.colors),
      background: colors.background,
      card: colors.headerBg,
      text: colors.headerText,
      primary: colors.primarySolid,
      border: colors.border,
    },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.headerBg },
          headerTitleStyle: {
            color: colors.headerText,
            fontFamily: FONT_FAMILY,
            fontSize: 17,
          },
          headerTintColor: colors.headerText,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {status === 'authenticated' ? (
          <>
            <Stack.Screen
              name="Main"
              component={MainTabs}
              options={{
                title: 'Stash',
                headerRight: () => (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void logout()}
                    testID="LogoutButton"
                    hitSlop={8}
                    style={({ pressed }) => [styles.logout, pressed ? styles.pressed : null]}
                  >
                    <Text style={[styles.logoutLabel, { color: colors.link }]}>Log out</Text>
                  </Pressable>
                ),
              }}
            />
            <Stack.Screen
              name="Notifications"
              component={NotificationsScreen}
              options={{ title: 'Notifications' }}
            />
          </>
        ) : (
          <>
            <Stack.Screen
              name="Login"
              component={LoginScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Register"
              component={RegisterScreen}
              options={{ headerShown: false }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logout: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  logoutLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: 15,
  },
  pressed: {
    opacity: 0.7,
  },
});
