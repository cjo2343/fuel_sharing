/**
 * Trip list item — driver name, odometer range in monospace, and amber cost.
 *
 * @startingPoint section="App Data" subtitle="Trip list item with odometer, km, cost" viewport="400x80"
 */
export interface TripCardProps {
  /** Date string (e.g. "15 jun") */
  date?: string;
  /** Odometer at trip start (km) */
  startOdo?: number;
  /** Odometer at trip end (km) */
  endOdo?: number;
  /** Driver name */
  driver?: string;
  /** Fuel cost assigned to this trip (kr) */
  cost?: number;
  /** Tap handler — adds hover lift when provided */
  onClick?: () => void;
}

export declare function TripCard(props: TripCardProps): JSX.Element;
