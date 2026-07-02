import React from 'react';

/**
 * User avatar with deterministic colour generation from name initials.
 * Used for group member lists, trip drivers, and settlement parties.
 */
export interface AvatarProps {
  /** Full name — drives initials + colour */
  name?: string;
  /** Image URL (overrides initials) */
  src?: string;
  /** Size tier */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Online presence dot: true = green, false = grey, undefined = hidden */
  online?: boolean;
}

export declare function Avatar(props: AvatarProps): JSX.Element;
