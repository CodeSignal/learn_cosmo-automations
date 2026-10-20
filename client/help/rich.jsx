/**
 * Minimal inline markup for documentation strings.
 *
 * The node docs are plain strings so they can live in a shared module and be
 * checked by tests, but they naturally want inline code: field names, operators,
 * `{{ }}` spans. Without this they render as literal backticks, which is exactly
 * the sort of thing that makes documentation look unfinished.
 *
 * Deliberately just backticks. Anything more and the docs stop being plain
 * strings, which is the property that keeps them testable.
 */
export function rich(text) {
  if (typeof text !== 'string') return text;
  if (!text.includes('`')) return text;

  const parts = text.split('`');
  return parts.map((part, index) => (
    // Odd indexes sit between a pair of backticks. A trailing unpaired backtick
    // leaves its content as plain text rather than swallowing the rest.
    index % 2 === 1 && index < parts.length - 1
      ? <code key={`${index}-${part}`}>{part}</code>
      : <span key={`${index}-${part}`}>{part}</span>
  ));
}
