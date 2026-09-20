const normalizedTitle = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const titleKey = (title: string) =>
  normalizedTitle(title.replace(/^(?:the|an|a)\s+/i, ""));

/** Compare database titles while tolerating articles, accents, spaces, and punctuation. */
export function titleMatches(left: string, right: string) {
  return titleKey(left) === titleKey(right);
}
