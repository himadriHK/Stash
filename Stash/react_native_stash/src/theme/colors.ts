/**
 * Color palette transcribed from Stash.Maui/Resources/Styles/Colors.xaml and
 * the AppThemeBinding values in Styles.xaml. Light values are the base palette;
 * dark values come from the Dark={...} halves of the MAUI styles.
 */

export const palette = {
  primary: '#512BD4',
  primaryDark: '#ac99ea',
  primaryDarkText: '#242424',
  secondary: '#DFD8F7',
  secondaryDarkText: '#9880e5',
  tertiary: '#2B0B98',

  white: '#FFFFFF',
  black: '#000000',
  magenta: '#D600AA',
  midnightBlue: '#190649',
  offBlack: '#1f1f1f',

  gray100: '#E1E1E1',
  gray200: '#C8C8C8',
  gray300: '#ACACAC',
  gray400: '#919191',
  gray500: '#6E6E6E',
  gray600: '#404040',
  gray900: '#212121',
  gray950: '#141414',

  error: '#B00020',
} as const;

export interface ThemeColors {
  /** Page background: White (light) / OffBlack (dark). */
  background: string;
  /** Card/raised surface. */
  card: string;
  /** Default label text: Black / White. */
  text: string;
  /** Secondary text. */
  textMuted: string;
  /** Headline/SubHeadline text: MidnightBlue / White. */
  headline: string;
  /** Accent purple (always #512BD4): snackbar, chips, switch (light). */
  primarySolid: string;
  /** Button background: Primary (light) / PrimaryDark (dark). */
  primary: string;
  /** Button text: White (light) / #242424 (dark). */
  onPrimary: string;
  /** Transparent link-button text: Primary (light) / White (dark). */
  link: string;
  /** Entry text: Black / White. */
  inputText: string;
  /** Entry placeholder: Gray200 / Gray500. */
  placeholder: string;
  /** Error labels: #B00020 in both modes. */
  error: string;
  /** ActivityIndicator: Primary / White. */
  indicator: string;
  /** Border stroke: Gray200 / Gray500. */
  border: string;
  /** Disabled button background: Gray200 / Gray600. */
  disabledButtonBg: string;
  /** Disabled button text: Gray950 / Gray200. */
  disabledButtonText: string;
  /** Disabled control text: Gray300 / Gray600. */
  disabledText: string;
  /** Device-ID note: Gray500 / Gray300. */
  note: string;
  /** Navigation header: White / OffBlack; title Black / #9880e5. */
  headerBg: string;
  headerText: string;
  /** Tab bar (Shell style): White / Black; selected Magenta / White. */
  tabBg: string;
  tabActive: string;
  tabInactive: string;
  /** Snackbar surface. */
  snackbarBg: string;
  snackbarText: string;
  /** Switch (MAUI Switch style). */
  switchTrackOn: string;
  switchTrackOff: string;
  switchThumb: string;
  /** Secondary surface: Secondary / SecondaryDarkText. */
  secondarySurface: string;
}

export const lightColors: ThemeColors = {
  background: palette.white,
  card: palette.white,
  text: palette.black,
  textMuted: palette.gray600,
  headline: palette.midnightBlue,
  primarySolid: palette.primary,
  primary: palette.primary,
  onPrimary: palette.white,
  link: palette.primary,
  inputText: palette.black,
  placeholder: palette.gray200,
  error: palette.error,
  indicator: palette.primary,
  border: palette.gray200,
  disabledButtonBg: palette.gray200,
  disabledButtonText: palette.gray950,
  disabledText: palette.gray300,
  note: palette.gray500,
  headerBg: palette.white,
  headerText: palette.black,
  tabBg: palette.white,
  tabActive: palette.magenta,
  tabInactive: palette.gray900,
  snackbarBg: palette.primary,
  snackbarText: palette.white,
  switchTrackOn: palette.primary,
  switchTrackOff: palette.gray200,
  switchThumb: palette.white,
  secondarySurface: palette.secondary,
};

export const darkColors: ThemeColors = {
  background: palette.offBlack,
  card: palette.gray950,
  text: palette.white,
  textMuted: palette.gray300,
  headline: palette.white,
  primarySolid: palette.primary,
  primary: palette.primaryDark,
  onPrimary: palette.primaryDarkText,
  link: palette.white,
  inputText: palette.white,
  placeholder: palette.gray500,
  error: palette.error,
  indicator: palette.white,
  border: palette.gray500,
  disabledButtonBg: palette.gray600,
  disabledButtonText: palette.gray200,
  disabledText: palette.gray600,
  note: palette.gray300,
  headerBg: palette.offBlack,
  headerText: palette.secondaryDarkText,
  tabBg: palette.black,
  tabActive: palette.white,
  tabInactive: palette.gray200,
  snackbarBg: palette.gray900,
  snackbarText: palette.white,
  switchTrackOn: palette.white,
  switchTrackOff: palette.gray600,
  switchThumb: palette.primary,
  secondarySurface: palette.secondaryDarkText,
};
