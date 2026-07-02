/**
 * Settlement balance row — amber for amounts owed, leaf for amounts receivable.
 * Central to the settlement screen. Lead with the number per brand data hierarchy spec.
 */
export interface SettlementCardProps {
  /** The other person's name */
  personName: string;
  /** Amount in the given currency */
  amount: number | string;
  /** Currency symbol */
  currency?: string;
  /** Direction: owe=amber+Request, receive=leaf+Mark paid, settled=muted */
  direction?: 'owe' | 'receive' | 'settled';
  /** CTA handler — "Request" (owe) or "Mark paid" (receive) */
  onAction?: () => void;
}

export declare function SettlementCard(props: SettlementCardProps): JSX.Element;
