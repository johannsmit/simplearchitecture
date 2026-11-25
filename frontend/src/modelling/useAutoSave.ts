import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How long after the last keystroke a text field's change is saved. */
export const autoSaveDelayMillis = 800;

/**
 * How one save went: stored, not (or not all of it) stored with a short reason, nothing sent, or
 * nothing stored but worth sending again at once (the draft was put right). A failure the form
 * already announces in a `role="alert"` box is `announced`, so screen readers hear it once.
 */
export type SaveOutcome =
  | { kind: 'saved' }
  | { kind: 'failed'; reason: string; announced?: boolean }
  | { kind: 'none' }
  | { kind: 'again' };

/**
 * Sends what the form holds now, once. Calls `sending` just before a request goes out, so the
 * status says "Saving…" only when something is sent.
 */
export type SaveRun = (sending: () => void) => Promise<SaveOutcome>;

export type SavePhase = 'idle' | 'saving' | 'saved' | 'failed';

export interface AutoSave {
  phase: SavePhase;
  /** Why the last save failed (phase 'failed'). */
  reason: string;
  /**
   * For the always-mounted `role="status"` region: "Saved" once per save, or why not (unless an
   * alert box says so already).
   */
  announcement: string;
  /** A change is waiting (typing pause) or being sent. */
  busy: boolean;
  /** A text field changed: saves after the typing pause. */
  later: () => void;
  /** Saves now: a pick, Ctrl+Enter or Try again. A change waiting goes with it. */
  now: () => void;
  /** A field lost focus: a change waiting for the pause is saved now. */
  blur: () => void;
  /** Saves what is waiting, and resolves once nothing is waiting or being sent. */
  flush: () => Promise<void>;
  /** A fresh start (Reload): no status. */
  clear: () => void;
}

/**
 * The details panel's auto-save: at most one save in flight. Edits made meanwhile wait and go
 * together in the next save, which `run` builds from the form's latest state (and the version
 * the last response gave), so a burst of edits is saved in order without a false conflict.
 */
export function useAutoSave(run: SaveRun): AutoSave {
  // The run of the latest render: it sees the latest draft, and what the last response set.
  const latestRun = useRef(run);
  useLayoutEffect(() => {
    latestRun.current = run;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanted = useRef(false);
  const inFlight = useRef(false);
  const waiters = useRef<(() => void)[]>([]);
  // The form has closed: what is left is still sent, once the save on its way is done.
  const closed = useRef(false);
  const [, setTick] = useState(0);
  const [phase, setPhase] = useState<SavePhase>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Counted, so the same words said twice still change the live region.
  const [said, setSaid] = useState({ text: '', count: 0 });

  /** Sends what is left after the form closed, once; nothing shows it any more. */
  const sendClosed = () => {
    wanted.current = false;
    void latestRun.current(() => undefined).catch(() => undefined);
  };

  const poke = useCallback(() => {
    setTick((tick) => tick + 1);
  }, []);
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const edited = useCallback(() => {
    // "Saved" shows until the next edit; "Couldn't save" until the next save.
    setPhase((current) => (current === 'saved' ? 'idle' : current));
    setBusy(true);
  }, []);

  const now = useCallback(() => {
    clearTimer();
    wanted.current = true;
    edited();
    poke();
  }, [edited, poke]);

  const later = useCallback(() => {
    clearTimer();
    edited();
    timer.current = setTimeout(() => {
      timer.current = null;
      wanted.current = true;
      poke();
    }, autoSaveDelayMillis);
  }, [edited, poke]);

  const blur = useCallback(() => {
    if (timer.current !== null) now();
  }, [now]);

  const flush = useCallback((): Promise<void> => {
    if (timer.current !== null) now();
    if (!wanted.current && !inFlight.current) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.current.push(resolve);
      poke();
    });
  }, [now, poke]);

  // After each render: start the wanted save with the latest state, or tell those waiting that
  // nothing is left to send.
  useEffect(() => {
    if (inFlight.current) return;
    if (wanted.current) {
      wanted.current = false;
      inFlight.current = true;
      let sent = false;
      const done = (outcome: SaveOutcome) => {
        inFlight.current = false;
        if (closed.current) {
          if (wanted.current || outcome.kind === 'again') sendClosed();
          return;
        }
        if (outcome.kind === 'saved') {
          setPhase('saved');
          setSaid((current) => ({ text: 'Saved', count: current.count + 1 }));
        } else if (outcome.kind === 'failed') {
          setPhase('failed');
          setReason(outcome.reason);
          // An alert box already says why: the status region stays quiet, not saying it twice.
          setSaid((current) => ({
            text: outcome.announced === true ? '' : `Couldn't save: ${outcome.reason}`,
            count: current.count + 1,
          }));
        } else if (outcome.kind === 'again') {
          wanted.current = true;
        } else if (sent) {
          setPhase('idle');
        } else {
          setPhase((current) => (current === 'failed' ? 'idle' : current));
        }
        if (!wanted.current && timer.current === null) setBusy(false);
        poke();
      };
      latestRun
        .current(() => {
          sent = true;
          setPhase('saving');
        })
        .then(done, () => {
          done({ kind: 'failed', reason: 'check your connection' });
        });
      return;
    }
    if (timer.current === null && waiters.current.length > 0) {
      const resolve = waiters.current;
      waiters.current = [];
      for (const each of resolve) each();
    }
  });

  // Closing the form with a change waiting (for the pause, or for the save on its way): it is
  // sent, not lost. The last render's run sends it with the version the last response gave.
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (timer.current !== null) {
        clearTimer();
        wanted.current = true;
      }
      if (wanted.current && !inFlight.current) sendClosed();
    };
  }, []);

  const clear = useCallback(() => {
    setPhase('idle');
    setReason('');
  }, []);

  const announcement = said.text === '' || said.count % 2 === 1 ? said.text : `${said.text}\u00a0`;
  return { phase, reason, announcement, busy, later, now, blur, flush, clear };
}
