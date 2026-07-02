/**
 * Empty-data placeholder for lists, tables, and card groups with zero items.
 * Voice: encouraging and direct — "No trips yet" not "No data available."
 */
export interface EmptyStateProps {
  /** Icon element or emoji string rendered in a Mist circle */
  icon?: React.ReactNode;
  /** Heading — short and human ("No trips yet") */
  title?: string;
  /** Supporting text — one sentence max */
  description?: string;
  /** Optional call-to-action button */
  action?: { label: string; onClick: () => void };
  /** Compact mode — less padding for inline usage (default false) */
  compact?: boolean;
}

export declare function EmptyState(props: EmptyStateProps): JSX.Element;
