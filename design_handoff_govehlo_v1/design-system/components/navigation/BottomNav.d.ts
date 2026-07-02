/**
 * App-level bottom tab navigation. Brand spec: Home, Trips, Fuel, Settlement, History.
 */
export interface BottomNavItem {
  /** Unique identifier — matched against `active` */
  id: string;
  /** Tab icon (React node) */
  icon: React.ReactNode;
  /** Tab label */
  label: string;
}

export interface BottomNavProps {
  /** Tab definitions */
  items: BottomNavItem[];
  /** Currently active tab id */
  active?: string | number;
  /** Selection handler — receives item id */
  onSelect?: (id: string | number) => void;
}

export declare function BottomNav(props: BottomNavProps): JSX.Element;
