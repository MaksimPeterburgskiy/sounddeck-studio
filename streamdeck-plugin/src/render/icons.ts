/** The same 24px artwork used by imgs/*-key.svg; no font-dependent symbols. */
export const keyIcons = {
  "board-slot": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  "stop-all": '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>',
  "cycle-boards": '<path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5M4 16a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
  "page-next": '<path d="m9 5 7 7-7 7"/>',
  "page-previous": '<path d="m15 5-7 7 7 7"/>',
  "toggle-off": '<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="8" cy="12" r="3" fill="currentColor" stroke="none"/>',
  "toggle-on": '<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="16" cy="12" r="3" fill="currentColor" stroke="none"/>',
} as const;
