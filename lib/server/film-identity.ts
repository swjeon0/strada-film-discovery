const normalizedTitle = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const titleKey = (title: string) =>
  normalizedTitle(title.replace(/^(?:the|an|a)\s+/i, ""));

const personKey = (value: string) =>
  (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .sort()
    .join("\u0000");

/** Split a database or model director credit without depending on one separator. */
export function directorNames(value: string) {
  return value
    .split(/\s*(?:,|;|&|\band\b)\s*/giu)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Compare database titles while tolerating articles, accents, spaces, and punctuation. */
export function titleMatches(left: string, right: string) {
  return titleKey(left) === titleKey(right);
}

/**
 * Compare one or more director credits. Individual names tolerate accents and
 * culturally reversed order. A single credited director may identify a
 * co-directed film; two multi-name credits must contain the same people.
 */
export function directorMatches(left: string, right: string) {
  const wholeLeft = personKey(left),
    wholeRight = personKey(right);
  if (!wholeLeft || !wholeRight) return false;
  if (wholeLeft === wholeRight) return true;
  const leftNames = [...new Set(directorNames(left).map(personKey))],
    rightNames = [...new Set(directorNames(right).map(personKey))];
  if (leftNames.length === 1) return rightNames.includes(leftNames[0]);
  if (rightNames.length === 1) return leftNames.includes(rightNames[0]);
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name) => rightNames.includes(name))
  );
}
