import type { ReactNode } from 'react';

/** Keys shown as a symbol, with the word a screen reader says in its place. */
const keyWords: Record<string, string> = {
  '↑': 'Up arrow',
  '↓': 'Down arrow',
  '←': 'Left arrow',
  '→': 'Right arrow',
  '⌘': 'Command',
  '/': 'Slash',
  '*': 'Asterisk',
  '+': 'Plus',
  '=': 'Equals',
  '-': 'Minus',
  '@': 'At sign',
  '{': 'Opening brace',
};

/** One key, e.g. Enter, or ↑ read as "Up arrow". */
export function Key({ name }: { name: string }) {
  const word = keyWords[name];
  if (word === undefined) return <kbd>{name}</kbd>;
  return (
    <kbd>
      <span aria-hidden="true">{name}</span>
      <span className="vh">{word}</span>
    </kbd>
  );
}

/**
 * Text written the way the guide writes it: `Enter` is a key and **Save** is bold. The keyboard
 * tables keep the guide's own key cells (e.g. "`Shift` + `Enter`"), so a test can compare them.
 */
export function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const [whole, key, bold] = match;
    parts.push(
      key !== undefined ? <Key key={match.index} name={key} /> : <b key={match.index}>{bold}</b>,
    );
    last = match.index + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
