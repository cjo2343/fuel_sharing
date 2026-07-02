export interface CheckboxProps {
  label?: string;
  checked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Helper text shown below the label */
  hint?: string;
  disabled?: boolean;
  id?: string;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
