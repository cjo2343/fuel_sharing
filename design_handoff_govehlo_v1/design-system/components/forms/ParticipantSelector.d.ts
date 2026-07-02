export interface ParticipantOption {
  id: string;
  name: string;
}

export interface ParticipantSelectorProps {
  /** Array of participant names (strings) or {id, name} objects */
  participants?: (string | ParticipantOption)[];
  /** Array of currently selected participant IDs/names */
  selected?: string[];
  /** Called with the full updated selected array when a participant is toggled */
  onChange?: (selected: string[]) => void;
}
export declare function ParticipantSelector(props: ParticipantSelectorProps): JSX.Element;
