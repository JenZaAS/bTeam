// Generic interface strings only (no project content). Add a language by adding a block.
const STRINGS = {
  en: {
    home: 'Overview',
    search: 'Search',
    searchPlaceholder: 'Search documents and issues',
    noResults: 'No results.',
    latest: 'Latest',
    older: 'Older',
    empty: 'Nothing here yet.',
    notFound: 'Not found',
    notFoundText: 'This page does not exist or is not available to you.',
    sourceCommit: 'Source',
    syncedAt: 'synced',
    notSynced: 'The source has not been mirrored yet.',
    issuesUnavailable: 'Issues are not available right now.',
    contents: 'Contents',
    folders: 'Folders',
    all: 'all',
    notes: 'Notes',
    open: 'open',
    closed: 'closed',
    status: 'Status',
    date: 'Date',
    binary: 'Binary file, not shown.',
    download: 'Show raw',
    links: 'Links',
    previewRole: 'Preview as role',
    fallbackNote: 'No decision records yet. Showing:',
    up: 'Up',
    root: 'Top',
  },
  nb: {
    home: 'Oversikt',
    search: 'Søk',
    searchPlaceholder: 'Søk i dokumenter og saker',
    noResults: 'Ingen treff.',
    latest: 'Siste',
    older: 'Eldre',
    empty: 'Ingenting her ennå.',
    notFound: 'Ikke funnet',
    notFoundText: 'Denne siden finnes ikke eller er ikke tilgjengelig for deg.',
    sourceCommit: 'Kilde',
    syncedAt: 'synkronisert',
    notSynced: 'Kilden er ikke speilet ennå.',
    issuesUnavailable: 'Saker er ikke tilgjengelige akkurat nå.',
    contents: 'Innhold',
    folders: 'Mapper',
    all: 'alle',
    notes: 'Notater',
    open: 'åpen',
    closed: 'lukket',
    status: 'Status',
    date: 'Dato',
    binary: 'Binærfil, vises ikke.',
    download: 'Vis rå',
    links: 'Lenker',
    previewRole: 'Forhåndsvisning som rolle',
    fallbackNote: 'Ingen beslutningsnotater ennå. Viser:',
    up: 'Opp',
    root: 'Topp',
  },
};

export function strings(locale) {
  return { ...STRINGS.en, ...(STRINGS[locale] ?? {}) };
}

export function pickLocale(acceptLanguage, available) {
  const wanted = String(acceptLanguage ?? '')
    .split(',')
    .map((s) => s.split(';')[0].trim().toLowerCase().split('-')[0])
    .filter(Boolean);
  const alias = { no: 'nb', nn: 'nb' };
  for (const w of wanted) {
    const l = alias[w] ?? w;
    if (available.includes(l)) return l;
  }
  return available[0];
}
