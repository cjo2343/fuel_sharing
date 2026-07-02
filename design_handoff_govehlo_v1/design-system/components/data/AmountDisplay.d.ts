/**
 * Prominent monetary amount — the most important data element on settlement and fuel cards.
 * Amber for amounts owed, Leaf for amounts receivable, muted for settled.
 *
 * @startingPoint section="App Data" subtitle="Prominent monetary amount — amber (owe) · leaf (receive) · muted (settled)" viewport="400x120"
 */
export interface AmountDisplayProps {
  /** Numeric value — formatted to 2 decimal places with Danish comma */
  amount: number | string;
  /** Currency symbol or code */
  currency?: string;
  /** Direction drives colour: owe=amber, receive=leaf, settled=muted */
  direction?: 'owe' | 'receive' | 'settled';
  /** Optional label above the amount */
  label?: string;
  /** Visual size */
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export declare function AmountDisplay(props: AmountDisplayProps): JSX.Element;
