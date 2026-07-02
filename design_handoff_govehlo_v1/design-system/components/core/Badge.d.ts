import React from 'react';

/**
 * Compact status label. Use `variant="money"` for monetary states, `variant="success"` for settled/paid.
 */
export interface BadgeProps {
  /** Visual style */
  variant?: 'default' | 'success' | 'money' | 'pending' | 'error' | 'neutral' | 'forest';
  /** Size tier */
  size?: 'sm' | 'md' | 'lg';
  /** Show a leading dot indicator */
  dot?: boolean;
  /** Badge label */
  children?: React.ReactNode;
}

export declare function Badge(props: BadgeProps): JSX.Element;
