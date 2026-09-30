export const endings = ['\n', '\r\n', '\r'];
export function richMarkupInput(family, n, ending) {
  const source = family.layout === 'nested'
    ? family.open.repeat(n) + family.fragment + family.close.repeat(n) + '\n'
    : family.open + family.fragment.repeat(n) + family.close;
  return source.replaceAll('\n', ending);
}
