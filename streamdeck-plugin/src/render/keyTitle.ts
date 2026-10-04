// Approximate Arial at the manifest's 13pt size on a 144px key. Keep the SDK
// title clear of the margin; user-supplied titles still follow SDK precedence.
const characterWidth = (c: string) =>
  /[MW@%]/.test(c) ? 24 : /[ilI.,'!:;|]/.test(c) ? 7 : /[frt ()-]/.test(c) ? 10 : /[A-Z]/.test(c) ? 19 : 15;
const width = (text: string) => Array.from(text).reduce((total, c) => total + characterWidth(c), 0);
const fit = (text: string, ellipsis = false) => {
  const chars = Array.from(text);
  let remainingWidth = chars.reduce((total, c) => total + characterWidth(c), 0);
  // Measure once and subtract each removed code point; join only the fitted text.
  while (chars.length && remainingWidth + (ellipsis ? characterWidth("…") : 0) > 124) {
    remainingWidth -= characterWidth(chars.pop()!);
    ellipsis = true;
  }
  return chars.join("").trimEnd() + (ellipsis ? "…" : "");
};

export function keyTitle(title: string): string {
  if (title.includes("\n")) return title.split("\n").slice(0, 2).map((line) => fit(line)).join("\n");
  const words = title.trim().split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const index = lines.length - 1;
    const next = lines[index] ? `${lines[index]} ${word}` : word;
    if (!lines[index] || width(next) <= 124) lines[index] = next;
    else if (lines.length < 2) lines.push(word);
    else { lines[1] = fit(`${lines[1]} ${word}`, true); break; }
  }
  return lines.map((line) => fit(line)).join("\n");
}
