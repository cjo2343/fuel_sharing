export type StatusChipStatus = 'open' | 'requested' | 'paid' | 'pending';

export interface StatusChipProps {
  /**
   * Settlement payment status.
   * - `open`      — amber — awaiting request
   * - `requested` — blue  — payment has been requested (MobilePay)
   * - `paid`      — green — payment confirmed
   * - `pending`   — warm  — generic awaiting state
   */
  status?: StatusChipStatus;
  /** Override the display label */
  label?: string;
}
export declare function StatusChip(props: StatusChipProps): JSX.Element;
