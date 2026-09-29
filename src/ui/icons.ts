/** Inline SVG icons (24x24, stroke based, currentColor). */
const svg = (body: string, extra = ''): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

export const ICONS = {
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>'),
  play1: svg('<path d="M8 5l10 7-10 7z" fill="currentColor" stroke="none"/>'),
  play2: svg('<path d="M4 6l8 6-8 6z M12 6l8 6-8 6z" fill="currentColor" stroke="none"/>'),
  play3: svg('<path d="M2 7l6 5-6 5z M9 7l6 5-6 5z M16 7l6 5-6 5z" fill="currentColor" stroke="none"/>'),
  road: svg('<path d="M5 21L9 3M19 21L15 3M12 5v2M12 11v2M12 17v2"/>'),
  bulldoze: svg('<path d="M3 17h11l3-6H9L7 7H3z"/><circle cx="6" cy="19" r="1.6"/><circle cx="12" cy="19" r="1.6"/><path d="M17 11l4-2v8l-4-2"/>'),
  zone: svg('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>'),
  junction: svg('<path d="M12 2v20M2 12h20"/><circle cx="12" cy="12" r="3.5"/>'),
  lanes: svg('<path d="M7 21V10l-3 3M7 10l3 3M17 21v-9c0-3 2-5 4-5M18 5l3 2-2 3"/>'),
  speed: svg('<circle cx="12" cy="12" r="9"/><path d="M12 12l4-4"/><path d="M8 16h8"/>'),
  bus: svg('<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v3M16 18v3"/><circle cx="8" cy="14.5" r="1"/><circle cx="16" cy="14.5" r="1"/>'),
  eye: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  cursor: svg('<path d="M5 3l14 8-6 2-2 6z"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  dice: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="16" cy="16" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>'),
  people: svg('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14c3 0 5 2 5 5"/>'),
  money: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  car: svg('<path d="M5 16V11l2-5h10l2 5v5z"/><path d="M5 11h14"/><circle cx="8" cy="16" r="1.6"/><circle cx="16" cy="16" r="1.6"/>'),
  light: svg('<rect x="8" y="2" width="8" height="20" rx="3"/><circle cx="12" cy="7" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="17" r="1.6"/>'),
  sign: svg('<path d="M12 3l9 16H3z"/>'),
  roundabout: svg('<circle cx="12" cy="12" r="5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 0c0 2-2.5 2-2.5 4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  save: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 14h8v7H8z"/>'),
  truck: svg('<rect x="2" y="7" width="12" height="9" rx="1"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>'),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
} as const;
