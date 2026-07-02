export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  /** Array of option strings or { value, label } objects */
  options?: (string | SelectOption)[];
  /** Placeholder — renders as a disabled first option */
  placeholder?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  id?: string;
}
export declare function Select(props: SelectProps): JSX.Element;
