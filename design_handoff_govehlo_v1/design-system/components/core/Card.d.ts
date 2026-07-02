import React from 'react';

/**
 * Base surface container. All GoVehlo content lives in cards (16px radius per brand spec).
 */
export interface CardProps {
  /** Card contents */
  children?: React.ReactNode;
  /** Internal padding */
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  /** Stronger drop shadow (modals, bottom sheets) */
  elevated?: boolean;
  /** Mist-green tinted fill instead of white */
  tinted?: boolean;
  /** Makes the card tappable with hover lift */
  onClick?: () => void;
  /** Additional inline styles */
  style?: React.CSSProperties;
}

export declare function Card(props: CardProps): JSX.Element;
