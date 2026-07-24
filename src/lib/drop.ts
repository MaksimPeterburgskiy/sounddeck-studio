interface TopLevelDragEvent {
  preventDefault: () => void;
  dataTransfer?: {
    types?: readonly string[];
  } | null;
}

export function cancelTopLevelDrag(event: TopLevelDragEvent) {
  event.preventDefault();
  return event.dataTransfer?.types?.includes("Files") === true;
}
