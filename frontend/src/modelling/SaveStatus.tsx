import { Icon } from '../icons';
import type { AutoSave } from './useAutoSave';

/** "1 field needs a fix", "2 fields need a fix". */
export const fixReason = (count: number): string =>
  count === 1 ? '1 field needs a fix' : `${count} fields need a fix`;

/**
 * The details panel's save status, in its head: "Saving…", "Saved" or "Couldn't save: why".
 * Screen readers hear "Saved" once per save, and why a save failed, never "Saving…".
 */
export function SaveStatus({ saver }: { saver: AutoSave }) {
  const text =
    saver.phase === 'saving'
      ? 'Saving…'
      : saver.phase === 'saved'
        ? 'Saved'
        : saver.phase === 'failed'
          ? `Couldn't save: ${saver.reason}`
          : '';
  return (
    <>
      <p className={`save-status is-${saver.phase}`} title={text === '' ? undefined : text}>
        {saver.phase === 'saving' && <span className="spinner sm" aria-hidden="true" />}
        {saver.phase === 'saved' && <Icon name="check" size="sm" />}
        {saver.phase === 'failed' && <Icon name="alert" size="sm" />}
        <span className="save-status-text">{text}</span>
      </p>
      <span className="vh" role="status">
        {saver.announcement}
      </span>
    </>
  );
}
