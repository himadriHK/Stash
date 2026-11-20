/** Typography transcribed from Stash.Maui Styles.xaml (OpenSansRegular). */

export const FONT_FAMILY = 'OpenSans_400Regular';

export const fontSizes = {
  /** Headline style: 32, centered. */
  headline: 32,
  /** SubHeadline style: 24, centered. */
  subHeadline: 24,
  /** Body / Entry / Button: 14. */
  body: 14,
  /** Device-ID note and status details: 12. */
  small: 12,
} as const;

/** Form layout constants from LoginPage/RegisterPage XAML. */
export const layout = {
  /** MaximumWidthRequest on the auth forms. */
  formMaxWidth: 480,
  /** Padding="24,48" on the auth forms. */
  formPaddingHorizontal: 24,
  formPaddingVertical: 48,
  /** Spacing="14" between form entries. */
  formSpacing: 14,
  /** MainPage padding/spacing. */
  pagePadding: 30,
  pageSpacing: 20,
  /** Button CornerRadius / MinimumHeightRequest / Padding from Styles.xaml. */
  buttonRadius: 8,
  buttonMinHeight: 44,
  buttonPaddingHorizontal: 14,
  buttonPaddingVertical: 10,
} as const;
