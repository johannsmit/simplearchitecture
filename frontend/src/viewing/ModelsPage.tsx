import type { ModelSummary } from '@simplearchitecture/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AdminNav } from '../admin/AdminNav';
import {
  ApiRequestError,
  deleteModel,
  getModel,
  importJgf,
  importOef,
  isModelRejected,
} from '../api';
import { useMe } from '../auth';
import { Icon } from '../icons';
import { useModels } from '../models';
import { DamagedModels } from './models/DamagedModels';
import { DeleteDialog, modelDeleteText } from './models/DeleteDialog';
import { saveModelFile } from './models/exportModel';
import { ImportPanel, type ImportState } from './models/ImportPanel';
import { NewModelDialog } from './models/NewModelDialog';
import {
  firstDirection,
  ModelTable,
  parseSort,
  sortModels,
  type SortKey,
} from './models/ModelTable';
import { checkImportFiles } from './models/words';

/** How long a newly imported or created row stays highlighted. */
const newRowMillis = 3000;

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}

interface DeleteTarget {
  model: ModelSummary;
  opener: HTMLButtonElement;
  deleting: boolean;
  error: string | null;
}

interface ModelsPageProps {
  /**
   * 'view' (Viewing home): a read-only list for everyone, each model one click from the explorer.
   * 'manage' (Admin → Models): also create empty models, import OEF and JGF files (picker or
   * drag and drop), and export and delete models.
   * 'model' (Modelling home): the read-only list, each model opening in Modelling.
   * The API allows saving, importing and deleting for Admins only, whatever this page shows.
   */
  mode: 'view' | 'manage' | 'model';
}

export function ModelsPage({ mode }: ModelsPageProps) {
  const me = useMe();
  const canModel = mode === 'manage' && me.spaces.includes('admin');
  const { list, editable, reload, added, removed } = useModels();
  const [params, setParams] = useSearchParams();
  const sort = parseSort(params.get('sort'), params.get('dir'));

  const [importState, setImportState] = useState<ImportState>({ kind: 'idle' });
  const busy = importState.kind === 'busy';
  const [newId, setNewId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [status, setStatus] = useState('');
  const [newModelOpen, setNewModelOpen] = useState(false);
  const [exporting, setExporting] = useState<ReadonlySet<string>>(new Set());
  const [exportError, setExportError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const newModelButton = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const nameLinks = useRef(new Map<string, HTMLAnchorElement>());
  /** The row whose name gets focus once a deleted row is gone ('' = the page title). */
  const focusAfterDelete = useRef<string | null>(null);

  const models = list.status === 'ready' ? sortModels(list.models, sort) : undefined;

  const onSort = (key: SortKey) => {
    const dir = sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : firstDirection[key];
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('sort', key);
        next.set('dir', dir);
        return next;
      },
      { replace: true },
    );
  };

  const startImport = (files: readonly File[]) => {
    // A file dropped while New model is open is ignored: no import behind the dialog.
    if (!canModel || busy || newModelOpen) return;
    const check = checkImportFiles(files);
    if (!check.ok) {
      setImportState({ kind: 'refused', message: check.message });
      return;
    }
    const { file, format } = check;
    setImportState({ kind: 'busy', fileName: file.name, size: file.size });
    (format === 'jgf' ? importJgf(file) : importOef(file))
      .then((result) => {
        setImportState({ kind: 'done', fileName: file.name, result });
        if (list.status === 'ready') added(result.model);
        else reload();
        setNewId(result.model.id);
      })
      .catch((error: unknown) => {
        if (
          error instanceof ApiRequestError &&
          error.status === 422 &&
          isModelRejected(error.body)
        ) {
          setImportState({ kind: 'rejected', fileName: file.name, body: error.body });
          return;
        }
        setImportState({
          kind: 'failed',
          fileName: file.name,
          format,
          status: error instanceof ApiRequestError ? error.status : 0,
          message: error instanceof Error ? error.message : '',
        });
      });
  };
  // The page-wide drop listener is registered once and calls the latest version.
  const latestStartImport = useRef(startImport);
  useEffect(() => {
    latestStartImport.current = startImport;
  });

  // The new row stays highlighted for a moment.
  useEffect(() => {
    if (newId === null) return;
    const timer = setTimeout(() => {
      setNewId(null);
    }, newRowMillis);
    return () => {
      clearTimeout(timer);
    };
  }, [newId]);

  // Drop a file anywhere on the page to import it (Modellers and Admins only).
  useEffect(() => {
    if (!canModel) return;
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      // Leaving the window (no element to go to) ends the drag over the page.
      if (event.relatedTarget === null) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      latestStartImport.current([...(event.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [canModel]);

  const chooseFile = () => {
    fileInput.current?.click();
  };

  // After a delete, focus goes to the next row's name, or the page title when there is none.
  useEffect(() => {
    const id = focusAfterDelete.current;
    if (id === null) return;
    focusAfterDelete.current = null;
    (nameLinks.current.get(id) ?? title.current)?.focus();
  }, [list]);

  /** Where focus goes once the delete dialog is gone (a modal dialog keeps the rest inert). */
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (deleteTarget !== null || newModelOpen || !returnFocusTo.current) return;
    returnFocusTo.current.focus();
    returnFocusTo.current = null;
  }, [deleteTarget, newModelOpen]);

  const closeNewModel = () => {
    returnFocusTo.current = newModelButton.current;
    setNewModelOpen(false);
  };

  const modelCreated = (model: ModelSummary) => {
    setNewModelOpen(false);
    // Replaces any import result; focus goes to its heading.
    setImportState({ kind: 'created', model, editable: editable === true });
    if (list.status === 'ready') added(model);
    else reload();
    setNewId(model.id);
  };

  const closeDelete = () => {
    returnFocusTo.current = deleteTarget?.opener ?? null;
    setDeleteTarget(null);
  };

  const finishDelete = (model: ModelSummary, message: string) => {
    const sorted = models ?? [];
    const at = sorted.findIndex((m) => m.id === model.id);
    const next = sorted[at + 1] ?? sorted[at - 1];
    setDeleteTarget(null);
    removed(model.id);
    setStatus(message);
    focusAfterDelete.current = next?.id ?? '';
  };

  const confirmDelete = () => {
    if (!deleteTarget || deleteTarget.deleting) return;
    const { model } = deleteTarget;
    setDeleteTarget({ ...deleteTarget, deleting: true, error: null });
    deleteModel(model.id)
      .then(() => {
        finishDelete(model, `Deleted “${model.name}”.`);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 404) {
          finishDelete(model, 'This model was already deleted.');
          return;
        }
        setDeleteTarget((current) =>
          current
            ? {
                ...current,
                deleting: false,
                error:
                  error instanceof ApiRequestError
                    ? `The model wasn't deleted. ${error.message}`
                    : "The model wasn't deleted.",
              }
            : current,
        );
      });
  };

  const exportModel = (model: ModelSummary) => {
    if (exporting.has(model.id)) return;
    setExporting((current) => new Set(current).add(model.id));
    setExportError(null);
    getModel(model.id)
      .then((document) => {
        saveModelFile(document, model.name);
        setStatus(`Exported “${model.name}”.`);
      })
      .catch((error: unknown) => {
        setExportError(
          error instanceof ApiRequestError
            ? `“${model.name}” wasn't exported. ${error.message}`
            : `“${model.name}” wasn't exported.`,
        );
      })
      .finally(() => {
        setExporting((current) => {
          const next = new Set(current);
          next.delete(model.id);
          return next;
        });
      });
  };

  const empty = list.status === 'ready' && list.models.length === 0;

  return (
    <main id={canModel ? 'content' : 'models'} tabIndex={-1} className="page-scroll models-page">
      <div className="page">
        {mode === 'manage' && <AdminNav />}
        <div className="page-head">
          <div>
            <h1 ref={title} tabIndex={-1}>
              Models
            </h1>
            <p>
              {canModel
                ? 'Create, import, export and delete the architecture models stored in SimpleArchitecture.'
                : mode === 'model'
                  ? 'Open a model to add, edit and delete its elements.'
                  : 'Architecture models you can explore. Open one to browse it.'}
            </p>
            {!canModel && me.spaces.includes('admin') && (
              <p>
                <Link to="/admin/models">Create, import, export or delete models in Admin</Link>
              </p>
            )}
          </div>
          {canModel && (
            <div className="page-actions">
              <button
                ref={newModelButton}
                className="btn lg"
                type="button"
                aria-haspopup="dialog"
                disabled={busy}
                onClick={() => {
                  setNewModelOpen(true);
                }}
              >
                <Icon name="plus" />
                New model
              </button>
              <button className="btn primary lg" type="button" disabled={busy} onClick={chooseFile}>
                <Icon name="upload" />
                Import file
              </button>
            </div>
          )}
        </div>

        {mode === 'model' && editable === false && (
          <div className="notice info-notice">
            <Icon name="info" />
            <p>
              Editing is off on this server. It needs a database, so models open read-only.
              {me.spaces.includes('admin') && (
                <>
                  {' '}
                  See <Link to="/admin/database">Admin → Database</Link>.
                </>
              )}
            </p>
          </div>
        )}

        {canModel && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".xml,.json,application/xml,text/xml,application/json"
              hidden
              aria-label="Model file to import"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = '';
                if (files.length > 0) startImport(files);
              }}
            />
            <ImportPanel
              state={importState}
              onDismiss={() => {
                const wasCreated = importState.kind === 'created';
                setImportState({ kind: 'idle' });
                if (wasCreated) newModelButton.current?.focus();
              }}
              onChooseFile={chooseFile}
            />
          </>
        )}

        {exportError !== null && (
          <p className="alert" role="alert">
            {exportError}
          </p>
        )}

        {list.status === 'error' ? (
          <div className="table-card load-error" role="alert">
            <Icon name="alert" />
            <div>
              <p>
                <b>The models couldn&apos;t be loaded.</b>
              </p>
              <p className="muted">{list.message}</p>
            </div>
            <button className="btn" type="button" onClick={reload}>
              Try again
            </button>
          </div>
        ) : empty ? (
          canModel ? (
            <button className="dropzone big" type="button" disabled={busy} onClick={chooseFile}>
              <Icon name="upload" />
              <span className="dz-title">Import your first model</span>
              <span>
                Drop a model file here: JGF (.json) as saved by Export, or ArchiMate OEF (.xml). Or{' '}
                <u>Choose a file</u>
              </span>
              <span className="muted">Max 5 MB for JGF, 10 MB for OEF.</span>
            </button>
          ) : (
            <div className="table-card empty">
              <Icon name="layers" />
              <p>No models yet. An admin can create or import one.</p>
            </div>
          )
        ) : (
          <ModelTable
            space={mode === 'model' ? 'modelling' : 'viewing'}
            models={models}
            sort={sort}
            onSort={onSort}
            canDelete={canModel}
            {...(canModel ? { onExport: exportModel, exporting } : {})}
            newId={newId}
            onDelete={(model, opener) => {
              setDeleteTarget({ model, opener, deleting: false, error: null });
            }}
            nameLink={(id, element) => {
              if (element) nameLinks.current.set(id, element);
              else nameLinks.current.delete(id);
            }}
          />
        )}

        {canModel && !empty && list.status === 'ready' && (
          <button className="dropzone" type="button" disabled={busy} onClick={chooseFile}>
            <Icon name="upload" />
            <span>
              Drop a model file here to import it: JGF (.json, max 5 MB) as saved by Export, or
              ArchiMate OEF (.xml, max 10 MB). Or <u>choose a file</u>.
            </span>
          </button>
        )}

        {canModel && (
          <DamagedModels
            onDeleted={(message) => {
              setStatus(message);
            }}
            fallbackFocus={title}
          />
        )}

        <p className="vh" role="status">
          {status}
        </p>
      </div>

      {canModel && dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop to import</span>
        </div>
      )}

      {newModelOpen && <NewModelDialog onCancel={closeNewModel} onCreated={modelCreated} />}

      {deleteTarget && (
        <DeleteDialog
          {...modelDeleteText(deleteTarget.model)}
          deleting={deleteTarget.deleting}
          error={deleteTarget.error}
          onCancel={closeDelete}
          onConfirm={confirmDelete}
        />
      )}
    </main>
  );
}
