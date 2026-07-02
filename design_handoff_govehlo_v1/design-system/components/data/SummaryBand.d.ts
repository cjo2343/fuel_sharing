export interface SummaryBandItem {
  label: string;
  /** Pre-formatted string value (e.g. "2,47 kr/km") or a raw number */
  value: string | number;
}

export interface SummaryBandProps {
  /**
   * Array of stat items — typically 2–4.
   * Each renders as a dark card with a label and a large display value.
   */
  items?: SummaryBandItem[];
}
export declare function SummaryBand(props: SummaryBandProps): JSX.Element;
