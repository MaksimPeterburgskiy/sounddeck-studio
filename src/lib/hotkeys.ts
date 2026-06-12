// Canonical accelerator format: tokens joined by "+", modifiers first
// (Ctrl, Alt, Shift, Meta) then remaining keys in press order. Unlike Electron
// accelerators, any combination of keys is allowed (e.g. "Num1+Num2" or
// "A+S+D") because matching happens in a low-level keyboard hook, not
// globalShortcut. The same token names are understood by electron/hotkeys.cjs.

export const MODIFIER_TOKENS = ["Ctrl", "Alt", "Shift", "Meta"];

const GKEY_PATTERN = /^G([1-9]|1[0-9]|20)$/i;

const codeTokens: Record<string, string> = {
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
  AltLeft: "Alt",
  AltRight: "Alt",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  MetaLeft: "Meta",
  MetaRight: "Meta",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  NumpadAdd: "NumAdd",
  NumpadSubtract: "NumSub",
  NumpadMultiply: "NumMult",
  NumpadDivide: "NumDiv",
  NumpadDecimal: "NumDec",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`"
};

// event.code is the physical key, so numpad keys map consistently regardless
// of NumLock state.
export function eventToToken(event: KeyboardEvent): string {
  const code = event.code;
  if (codeTokens[code]) return codeTokens[code];
  let match = /^Key([A-Z])$/.exec(code);
  if (match) return match[1];
  match = /^Digit(\d)$/.exec(code);
  if (match) return match[1];
  match = /^Numpad(\d)$/.exec(code);
  if (match) return `Num${match[1]}`;
  match = /^F(\d{1,2})$/.exec(code);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 24) return code;
  return "";
}

export function orderTokens(tokens: string[]): string[] {
  const unique = [...new Set(tokens)];
  const modifiers = MODIFIER_TOKENS.filter((modifier) => unique.includes(modifier));
  return [...modifiers, ...unique.filter((token) => !MODIFIER_TOKENS.includes(token))];
}

const legacyTokens: Record<string, string> = {
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  command: "Ctrl",
  cmd: "Ctrl",
  control: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  super: "Meta",
  numadd: "NumAdd",
  numsub: "NumSub",
  nummult: "NumMult",
  numdiv: "NumDiv",
  numdec: "NumDec",
  space: "Space",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  plus: "="
};

function normalizeToken(token: string): string {
  const lower = token.toLowerCase();
  if (legacyTokens[lower]) return legacyTokens[lower];
  let match = /^num(?:pad)?(\d)$/.exec(lower);
  if (match) return `Num${match[1]}`;
  match = /^f(\d{1,2})$/.exec(lower);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 24) return `F${match[1]}`;
  if (token.length === 1) return token.toUpperCase();
  return token;
}

// Converts both old Electron-style accelerators ("CommandOrControl+Alt+num3")
// and already-canonical values into the canonical form. G-keys pass through.
export function normalizeAccelerator(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (GKEY_PATTERN.test(trimmed)) return trimmed.toUpperCase();
  const tokens = trimmed.split("+").map((token) => token.trim()).filter(Boolean).map(normalizeToken);
  return orderTokens(tokens).join("+");
}

const displayNames: Record<string, string> = {
  NumAdd: "Num+",
  NumSub: "Num-",
  NumMult: "Num*",
  NumDiv: "Num/",
  NumDec: "Num."
};

export function formatAccelerator(accelerator: string) {
  if (!accelerator) return "";
  return normalizeAccelerator(accelerator)
    .split("+")
    .map((token) => displayNames[token] || token)
    .join("+");
}

// Only one hotkey capture may run at a time; claiming the slot cancels
// whichever capture currently holds it.
let activeCaptureCancel: (() => void) | null = null;

export function claimCaptureSlot(cancel: () => void): () => void {
  if (activeCaptureCancel && activeCaptureCancel !== cancel) activeCaptureCancel();
  activeCaptureCancel = cancel;
  return () => {
    if (activeCaptureCancel === cancel) activeCaptureCancel = null;
  };
}
