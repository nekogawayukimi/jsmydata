/** Petites icônes SVG en ligne (dessins originaux, couleur héritée du texte). */
const PATHS = {
  home: 'M8 1.5 1 7.5h2v7h4v-4h2v4h4v-7h2z',
  logout: 'M6 2h6v12H6v-2h4V4H6zM1 8l4-3.5V7h5v2H5v2.5z',
  reload: 'M8 2a6 6 0 1 0 6 6h-2a4 4 0 1 1-1.2-2.8L8.5 7.5H14V2l-1.8 1.8A6 6 0 0 0 8 2z',
  db: 'M8 1C4.7 1 2 2 2 3.5v9C2 14 4.7 15 8 15s6-1 6-2.5v-9C14 2 11.3 1 8 1zm0 1.5c2.8 0 4.5.7 4.5 1S10.8 4.5 8 4.5 3.5 3.8 3.5 3.5 5.2 2.5 8 2.5z',
  table: 'M1 2h14v12H1zm1.5 3v2.5h4.5V5zm6 0v2.5h5V5zM2.5 9v3.5h4.5V9zm6 0v3.5h5V9z',
  view: 'M8 3C4 3 1.3 6 1 8c.3 2 3 5 7 5s6.7-3 7-5c-.3-2-3-5-7-5zm0 8.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  column: 'M6 1h4v14H6z',
  key: 'M10.5 1a4.5 4.5 0 0 0-4.3 5.8L1 12v3h3v-1.5h1.5V12H7l1.2-1.2A4.5 4.5 0 1 0 10.5 1zm1 2.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2z',
  schema: 'M2 2h5v5H2zm7 0h5v5H9zM2 9h5v5H2zm7 0h5v5H9z',
  plus: 'M7 2h2v5h5v2H9v5H7V9H2V7h5z',
  sun: 'M8 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM7.3 0h1.4v2.5H7.3zm0 13.5h1.4V16H7.3zM0 7.3h2.5v1.4H0zm13.5 0H16v1.4h-2.5zM2.1 3.1l1-1 1.8 1.8-1 1zm9 9 1-1 1.8 1.8-1 1zm1.8-10 1 1-1.8 1.8-1-1zm-9 9 1 1-1.8 1.8-1-1z',
  moon: 'M10.5 1.2A7 7 0 1 0 14.8 11 5.5 5.5 0 0 1 10.5 1.2z',
  auto: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5v11a5.5 5.5 0 0 1 0-11z',
  collapse: 'M2 3h12v2H2zm0 4h12v2H2zm3 4h6v2H5z',
  plusBox: 'M2 2h12v12H2zm1.5 1.5v9h9v-9zM7.3 5h1.4v2.3H11v1.4H8.7V11H7.3V8.7H5V7.3h2.3z',
  minusBox: 'M2 2h12v12H2zm1.5 1.5v9h9v-9zM5 7.3h6v1.4H5z',
  doc: 'M3 1h7l3 3v11H3zm1.5 1.5v11h7V5H9V2.5z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, title, size = 16 }: { name: IconName; title?: string; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
