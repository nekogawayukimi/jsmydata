/** Taille lisible, à la manière de phpMyAdmin (Kio, Mio, Gio). */
export function formatBytes(n: number | null | undefined, lang: string): string {
  if (n === null || n === undefined) return '-';
  const units = lang.startsWith('fr') ? ['o', 'Kio', 'Mio', 'Gio', 'Tio'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : 1;
  return `${v.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[i]}`;
}

export function formatNumber(n: number | null | undefined, lang: string): string {
  if (n === null || n === undefined) return '-';
  return n.toLocaleString(lang);
}
