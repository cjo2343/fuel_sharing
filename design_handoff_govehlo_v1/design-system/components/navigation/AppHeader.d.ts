import React from 'react';

/**
 * Forest-green app header with greeting and optional action buttons.
 * Per spec, app header uses Forest (#2D6A4F) as status bar and greeting area.
 */
export interface AppHeaderProps {
  /** Primary heading — "Good morning, Christian" */
  greeting?: string;
  /** Secondary line — sync state, date, or group name */
  subtitle?: string;
  /** Action buttons / icon buttons on the right */
  actions?: React.ReactNode;
  /** Compact mode — shorter, for non-home screens */
  compact?: boolean;
}

export declare function AppHeader(props: AppHeaderProps): JSX.Element;
