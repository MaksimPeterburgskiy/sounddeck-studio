/** The same 24px artwork used by imgs/*-key.svg; no font-dependent symbols. */
export const keyIcons = {
  "board-slot": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  "speaker": '<path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  "speaker-muted": '<path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="m16 9 6 6m0-6-6 6"/>',
  "speaker-up": '<path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="M19 9v6m-3-3h6"/>',
  "speaker-down": '<path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="M16 12h6"/>',
  "stop-all": '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>',
  "cycle-boards": '<path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5M4 16a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
  "page-next": '<path d="m8.5 5 7 7-7 7"/>',
  "page-previous": '<path d="m15.5 5-7 7 7 7"/>',
  "toggle-off": '<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="8" cy="12" r="3" fill="currentColor" stroke="none"/>',
  "toggle-on": '<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="16" cy="12" r="3" fill="currentColor" stroke="none"/>',
  warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" fill="currentColor"/><rect x="11" y="8.5" width="2" height="6.5" rx="1" fill="#11181b"/><circle cx="12" cy="17.6" r="1.2" fill="#11181b"/>',
} as const;
