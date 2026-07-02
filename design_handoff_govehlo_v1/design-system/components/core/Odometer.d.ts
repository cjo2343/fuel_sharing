export interface OdometerProps {
  /** Numeric km value — formatted with Danish locale (period as thousands separator). Default 0. */
  value?: number;
  /** Unit label displayed beside the value. Default "km". */
  unit?: string;
}
export declare function Odometer(props: OdometerProps): JSX.Element;
