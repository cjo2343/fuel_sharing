/**
 * Circular loading indicator for in-progress actions.
 * Pair with a label for accessibility ("Syncing…", "Saving…").
 */
export interface SpinnerProps {
  /** Diameter preset */
  size?: 'sm' | 'md' | 'lg';
  /** Stroke color — token name or raw CSS color */
  color?: 'forest' | 'white' | 'muted' | 'amber' | string;
  /** Accessible label — also renders as visible text when provided */
  label?: string;
  /** Additional inline styles on wrapper span */
  style?: React.CSSProperties;
}

export declare function Spinner(props: SpinnerProps): JSX.Element;
