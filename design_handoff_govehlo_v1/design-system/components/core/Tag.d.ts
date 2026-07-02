/**
 * Dismissible label chip for categories, filters, and trip metadata.
 */
export interface TagProps {
  /** Tag text */
  label: string;
  /** Colour scheme */
  color?: 'default' | 'amber' | 'leaf' | 'neutral';
  /** If provided, renders a dismiss × button */
  onRemove?: () => void;
}

export declare function Tag(props: TagProps): JSX.Element;
