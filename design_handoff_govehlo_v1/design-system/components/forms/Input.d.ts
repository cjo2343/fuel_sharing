/**
 * Text input field with label, prefix/suffix, hint, and error states.
 * Used for odometer entries, fuel prices, and payment amounts.
 */
export interface InputProps {
  /** Field label */
  label?: string;
  /** HTML input type */
  type?: 'text' | 'number' | 'email' | 'tel' | 'password' | 'search';
  /** Placeholder text */
  placeholder?: string;
  /** Controlled value */
  value?: string | number;
  /** Change handler */
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Leading inline adornment (e.g. "kr", "km") */
  prefix?: string;
  /** Trailing inline adornment (e.g. "L", "/km") */
  suffix?: string;
  /** Helper text below the field */
  hint?: string;
  /** Error message — replaces hint and turns border red */
  error?: string;
  /** Disabled state */
  disabled?: boolean;
  /** HTML id (auto-generated if omitted) */
  id?: string;
}

export declare function Input(props: InputProps): JSX.Element;
