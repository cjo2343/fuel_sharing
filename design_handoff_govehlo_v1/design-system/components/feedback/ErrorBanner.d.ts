/**
 * Persistent inline banner for errors, warnings, and offline state.
 * Unlike Toast (transient), ErrorBanner stays until the condition clears.
 * Use for network failures, sync conflicts, offline mode, validation summaries.
 */
export interface ErrorBannerProps {
  /** Error message — say what happened + what the user can do */
  message: string;
  /** Visual severity */
  variant?: 'error' | 'warning' | 'offline';
  /** Retry handler — renders a "Retry" link */
  onRetry?: () => void;
  /** Dismiss handler — renders × button */
  onDismiss?: () => void;
  /** Additional content below the message (e.g. a list of validation errors) */
  children?: React.ReactNode;
}

export declare function ErrorBanner(props: ErrorBannerProps): JSX.Element;
