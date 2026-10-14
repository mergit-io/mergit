const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** "Two actions" style counts for sentence starts; digits from ten up. */
export function countPhrase(n: number, noun: string) {
  const word = n < WORDS.length ? WORDS[n] : String(n);
  return `${word} ${noun}${n === 1 ? "" : "s"}`;
}
