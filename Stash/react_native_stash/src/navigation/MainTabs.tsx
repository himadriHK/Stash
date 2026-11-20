/**
 * Bottom tab bar (5 tabs) with the Shell-style theming: White/OffBlack
 * surfaces, Magenta (light) / White (dark) active tint, OpenSans labels.
 */
import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import type { MainTabParamList } from './types';
import { FilesScreen } from '../screens/FilesScreen';
import { UploadScreen } from '../screens/UploadScreen';
import { FoldersScreen } from '../screens/FoldersScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { AboutScreen } from '../screens/AboutScreen';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY } from '../theme/typography';

const Tab = createBottomTabNavigator<MainTabParamList>();

const TABS: {
  name: keyof MainTabParamList;
  component: React.ComponentType;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  activeIcon: React.ComponentProps<typeof Ionicons>['name'];
}[] = [
  {
    name: 'Files',
    component: FilesScreen,
    icon: 'document-text-outline',
    activeIcon: 'document-text',
  },
  { name: 'Upload', component: UploadScreen, icon: 'cloud-upload-outline', activeIcon: 'cloud-upload' },
  { name: 'Folders', component: FoldersScreen, icon: 'folder-outline', activeIcon: 'folder' },
  { name: 'Settings', component: SettingsScreen, icon: 'settings-outline', activeIcon: 'settings' },
  {
    name: 'About',
    component: AboutScreen,
    icon: 'information-circle-outline',
    activeIcon: 'information-circle',
  },
];

export function MainTabs() {
  const { colors } = useTheme();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.tabActive,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarStyle: {
          backgroundColor: colors.tabBg,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: {
          fontFamily: FONT_FAMILY,
          fontSize: 11,
        },
      }}
    >
      {TABS.map((tab) => (
        <Tab.Screen
          key={tab.name}
          name={tab.name}
          component={tab.component}
          options={({ route }) => ({
            title: route.name,
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons
                name={focused ? tab.activeIcon : tab.icon}
                size={size}
                color={color}
              />
            ),
          })}
        />
      ))}
    </Tab.Navigator>
  );
}
