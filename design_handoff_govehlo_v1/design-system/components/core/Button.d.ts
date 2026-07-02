import React from 'react';

/**
 * GoVehlo primary interactive control — use `variant="amber"` exclusively for
 * money actions (request payment, add fuel cost). Never for navigation.
 *
 * @startingPoint section="Core UI" subtitle="Button — primary, secondary, ghost, amber (money), danger" viewport="700x220"
 */
export interface ButtonProps {
  /** Visual style */
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'amber' | 'danger';
  /** Size tier */
  size?: 'sm' | 'md' | 'lg';
  /** Disabled state — shows at 45% opacity, blocks interaction */
  disabled?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Button content */
  children?: React.ReactNode;
  /** Leading icon element */
  icon?: React.ReactNode;
  /** Stretch to full container width */
  fullWidth?: boolean;
  /** HTML button type */
  type?: 'button' | 'submit' | 'reset';
}

export declare function Button(props: ButtonProps): JSX.Element;
