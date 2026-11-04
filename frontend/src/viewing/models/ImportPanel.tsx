import type {
  ModelRejected,
  ModelSummary,
  OefMappingReport,
  SaveModelResult,
} from '@simplearchitecture/shared';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Icon } from '../../icons';
import { counted } from '../../words';
import { modelPath } from '../paths';
import { ReportChips, ReportSections, summaryChips } from './ImportReport';
import { fileSize, importFailureHeading, type ImportFormat } from './words';

export type ImportState =
  | { kind: 'idle' }
  /** Refused before upload by a client check. */
  | { kind: 'refused'; message: string }
  | { kind: 'busy'; fileName: string; size: number }
  /** Only an OEF import has a report: a JGF file is stored as it is. */
  | { kind: 'done'; fileName: string; result: SaveModelResult & { report?: OefMappingReport } }
  /** 422: the model has errors; nothing was saved. */
  | { kind: 'rejected'; fileName: string; body: ModelRejected }
  | { kind: 'failed'; fileName: string; format: ImportFormat; status: number; message: string }
  /** A new, empty model was created (New model). Shown in the same place as an import result. */
  | { kind: 'created'; model: ModelSummary; editable: boolean };

interface ImportPanelProps {
  state: ImportState;
  onDismiss: () => void;
  onChooseFile: () => void;
}

/**
 * The import panel above the model list: progress, result, rejection or failure; also the result
 * of New model.
 */
export function ImportPanel({ state, onDismiss, onChooseFile }: ImportPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const finished =
    state.kind === 'done' ||
    state.kind === 'rejected' ||
    state.kind === 'failed' ||
    state.kind === 'created';

  // Screen readers hear the result: focus moves to its heading when the import finishes.
  useEffect(() => {
    if (finished) heading.current?.focus();
  }, [finished, state]);

  switch (state.kind) {
    case 'idle':
      return null;

    case 'refused':
      return (
        <section className="result is-error" role="alert" aria-label="Import">
          <div className="result-head">
            <span className="result-icon bad" aria-hidden="true">
              <Icon name="alert" />
            </span>
            <div>
              <h2>{state.message}</h2>
              <p>Nothing was uploaded.</p>
            </div>
            <div className="actions">
              <button className="btn" type="button" onClick={onDismiss}>
                <Icon name="x" size="sm" />
                Dismiss
              </button>
            </div>
          </div>
        </section>
      );

    case 'busy':
      return (
        <section className="result" role="status" aria-label="Import in progress">
          <div className="result-head">
            <span className="spinner" aria-hidden="true" />
            <div className="busy-text">
              <h2>
                Importing {state.fileName} ({fileSize(state.size)})
              </h2>
              <p>Reading and checking the model. This can take a few seconds.</p>
              <progress className="busy-bar" aria-label="Importing" />
            </div>
          </div>
        </section>
      );

    case 'done': {
      const { model, report, validation } = state.result;
      return (
        <section className="result" aria-labelledby="import-result-title">
          <div className="result-head">
            <span className="result-icon ok" aria-hidden="true">
              <Icon name="check" />
            </span>
            <div>
              <h2 id="import-result-title" ref={heading} tabIndex={-1}>
                Imported “{model.name}”
              </h2>
              <p>
                {state.fileName} · {counted(model.nodeCount, 'element')} ·{' '}
                {counted(model.edgeCount, 'relationship')}
              </p>
            </div>
            <div className="actions">
              <Link className="btn primary" to={modelPath(model.id)}>
                Open in explorer
              </Link>
              <button
                className="btn"
                type="button"
                aria-label="Dismiss import result"
                onClick={onDismiss}
              >
                <Icon name="x" size="sm" />
                Dismiss
              </button>
            </div>
          </div>
          <ReportChips chips={summaryChips(report, validation.warningCount)} />
          <ReportSections
            {...(report === undefined ? {} : { report })}
            validation={validation}
            modelId={model.id}
          />
        </section>
      );
    }

    case 'created': {
      const { model } = state;
      return (
        <section className="result" aria-labelledby="import-result-title">
          <div className="result-head">
            <span className="result-icon ok" aria-hidden="true">
              <Icon name="check" />
            </span>
            <div>
              <h2 id="import-result-title" ref={heading} tabIndex={-1}>
                Created “{model.name}”
              </h2>
              <p>
                {state.editable
                  ? 'An empty model. Open it in Modelling to add its first element.'
                  : 'An empty model. Editing is off on this server, so it opens read-only.'}
              </p>
            </div>
            <div className="actions">
              <Link className="btn primary" to={modelPath(model.id, 'modelling')}>
                Open in Modelling
              </Link>
              <button
                className="btn"
                type="button"
                aria-label="Dismiss the result"
                onClick={onDismiss}
              >
                <Icon name="x" size="sm" />
                Dismiss
              </button>
            </div>
          </div>
        </section>
      );
    }

    case 'rejected': {
      const { validation, report } = state.body;
      const count = validation.errorCount;
      return (
        <section className="result is-error" aria-labelledby="import-result-title">
          <div className="result-head">
            <span className="result-icon bad" aria-hidden="true">
              <Icon name="alert" />
            </span>
            <div>
              <h2 id="import-result-title" ref={heading} tabIndex={-1}>
                Not imported: the model has {counted(count, 'error')}
              </h2>
              <p>
                {state.fileName} · Nothing was saved. Fix the errors in the source model and import
                again.
              </p>
            </div>
            <div className="actions">
              <button className="btn" type="button" onClick={onChooseFile}>
                Choose another file
              </button>
              <button
                className="btn"
                type="button"
                aria-label="Dismiss import result"
                onClick={onDismiss}
              >
                <Icon name="x" size="sm" />
                Dismiss
              </button>
            </div>
          </div>
          <ReportChips chips={summaryChips(report, validation.warningCount)} />
          <ReportSections
            {...(report === undefined ? {} : { report })}
            validation={validation}
            rejected
          />
        </section>
      );
    }

    case 'failed': {
      const title = importFailureHeading(state.status, state.format);
      return (
        <section className="result is-error" aria-labelledby="import-result-title">
          <div className="result-head">
            <span className="result-icon bad" aria-hidden="true">
              <Icon name="alert" />
            </span>
            <div>
              <h2 id="import-result-title" ref={heading} tabIndex={-1}>
                {title}
              </h2>
              <p>
                {state.fileName}
                {state.message !== '' && state.message !== title ? ` · ${state.message}` : ''}
              </p>
            </div>
            <div className="actions">
              {state.status === 401 ? (
                <a className="btn primary" href="/auth/login">
                  Sign in
                </a>
              ) : (
                <button className="btn" type="button" onClick={onChooseFile}>
                  Choose another file
                </button>
              )}
              <button
                className="btn"
                type="button"
                aria-label="Dismiss import result"
                onClick={onDismiss}
              >
                <Icon name="x" size="sm" />
                Dismiss
              </button>
            </div>
          </div>
        </section>
      );
    }
  }
}
