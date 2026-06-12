const electronKeyNames: Record<string, string> = {
  " ": "Space",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  escape: "Escape",
  esc: "Escape",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown"
};

export function formatAccelerator(accelerator: string) {
  return accelerator.replace("CommandOrControl", "Ctrl");
}

export function eventToAccelerator(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const raw = event.key.length === 1 ? event.key.toUpperCase() : event.key.toLowerCase();
  const key = electronKeyNames[raw] || (raw.startsWith("f") && /^f\d{1,2}$/.test(raw) ? raw.toUpperCase() : raw);
  const isModifierOnly = ["control", "Control", "shift", "Shift", "alt", "Alt", "meta", "Meta"].includes(key);
  if (isModifierOnly) return "";
  parts.push(key);
  return parts.join("+");
}
