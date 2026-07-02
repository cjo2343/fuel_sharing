export interface TabNavItem {
  id: string;
  label: string;
  /** Optional notification badge count — hidden when 0 or undefined */
  badge?: number;
}

export interface TabNavProps {
  items?: TabNavItem[];
  /** ID of the currently active tab */
  active?: string;
  onSelect?: (id: string) => void;
  /** Pin the nav to the top of its scroll container. Default false. */
  sticky?: boolean;
}
export declare function TabNav(props: TabNavProps): JSX.Element;
