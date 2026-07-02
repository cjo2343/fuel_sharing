/**
 * Shimmer loading placeholder. Uses the GoVehlo Mist palette so loading
 * states feel on-brand. Compose multiple Skeletons to build card/row placeholders.
 */
export interface SkeletonProps {
  /** Shape preset */
  variant?: 'line' | 'title' | 'circle' | 'card' | 'button';
  /** Override width (CSS string or number) */
  width?: string | number;
  /** Override height */
  height?: string | number;
  /** Override border-radius */
  radius?: string | number;
  /** Render multiple stacked lines (variant="line" shortens the last one) */
  count?: number;
  /** Gap between lines when count > 1 (default 8) */
  gap?: number;
  /** Additional inline styles */
  style?: React.CSSProperties;
}

export declare function Skeleton(props: SkeletonProps): JSX.Element;
