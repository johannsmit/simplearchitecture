import type { ViewProblem } from './useOpenView';

/** Over an open view's canvas: why the last change to it wasn't saved, and what to do. */
export function ViewNotice(props: {
  problem: ViewProblem;
  onReload: () => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const { problem } = props;
  return (
    <>
      <span>
        {problem === 'conflict'
          ? "Someone else changed this view. Your change wasn't saved."
          : problem === 'deleted'
            ? "Someone else deleted this view. Your change wasn't saved."
            : problem === 'rejected'
              ? "Your change to the view wasn't saved: part of it was deleted from the model meanwhile. Reload the page and try again."
              : "Your change to the view wasn't saved. Check your connection and try again."}
      </span>{' '}
      {problem === 'conflict' ? (
        <button type="button" className="linkbtn" onClick={props.onReload}>
          Reload view
        </button>
      ) : problem === 'deleted' ? (
        <button type="button" className="linkbtn" onClick={props.onClose}>
          Close view
        </button>
      ) : (
        <button type="button" className="linkbtn" onClick={props.onDismiss}>
          Dismiss
        </button>
      )}
    </>
  );
}
