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

const numpadAccelerators: Record<string, string> = {
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec"
};

const numpadDisplayNames: Record<string, string> = {
  numadd: "Num+",
  numsub: "Num-",
  nummult: "Num*",
  numdiv: "Num/",
  numdec: "Num."
};

export function formatAccelerator(accelerator: string) {
  return accelerator
    .replace("CommandOrControl", "Ctrl")
    .replace(/num(?:add|sub|mult|div|dec|\d)/g, (m) => numpadDisplayNames[m] || `Num${m.slice(3)}`);
}

export function eventToAccelerator(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  let key: string;
  if (/^Numpad\d$/.test(event.code)) {
    key = `num${event.code.slice(6)}`;
  } else if (numpadAccelerators[event.code]) {
    key = numpadAccelerators[event.code];
  } else {
    const raw = event.key.length === 1 ? event.key.toUpperCase() : event.key.toLowerCase();
    key = electronKeyNames[raw] || (raw.startsWith("f") && /^f\d{1,2}$/.test(raw) ? raw.toUpperCase() : raw);
  }
  const isModifierOnly = ["control", "Control", "shift", "Shift", "alt", "Alt", "meta", "Meta"].includes(key);
  if (isModifierOnly) return "";
  parts.push(key);
  return parts.join("+");
}
