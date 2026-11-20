import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Files: undefined;
  Upload: undefined;
  Folders: undefined;
  Settings: undefined;
  About: undefined;
};

export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
};
