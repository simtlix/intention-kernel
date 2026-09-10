/** Join authored answers without repeating a message wholly present in another.
 * No text is rewritten: callers retain all original claims and citation checks.
 */
export function joinCanonicalMessages(messages: readonly string[]): string {
  const unique = [...new Set(messages)];
  return unique.filter((message, index) => !unique.some((other, otherIndex) =>
    otherIndex !== index && other.includes(message),
  )).join("\n\n");
}
