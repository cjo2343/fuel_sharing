/**
 * Transient feedback notification. Per brand spec, payment actions show toast confirmation.
 */
export interface ToastProps {
  /** Toast message — keep short and direct ("Payment requested from Lars.") */
  message: string;
  /** Visual style */
  variant?: 'default' | 'success' | 'money' | 'error' | 'info';
  /** Controls visibility — animate in/out by toggling */
  visible?: boolean;
  /** Dismiss handler — renders × button if provided */
  onDismiss?: () => void;
}

export declare function Toast(props: ToastProps): JSX.Element | null;
