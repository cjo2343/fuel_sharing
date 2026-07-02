export interface FuelCardProps {
  date?: string;
  /** Name of the member who paid for fuel */
  paidBy?: string;
  /** Amount paid in DKK — displayed in amber */
  amountDkk?: number;
  /** Litres added — used to derive kr/L rate */
  liters?: number;
  /** Optional station/place name */
  station?: string;
  /** Whether the tank was filled to full — shows a green "Full tank" chip */
  fullTank?: boolean;
  /** Admin/owner edit callback — hides the Edit action when omitted */
  onEdit?: () => void;
}
export declare function FuelCard(props: FuelCardProps): JSX.Element;
