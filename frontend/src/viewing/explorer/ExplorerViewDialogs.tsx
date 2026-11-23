import type {
  GroupByChoice,
  ModelElement,
  Neighbourhood,
  StoredView,
} from '@simplearchitecture/shared';
import { useNavigate } from 'react-router';
import { counted } from '../../words';
import { modelStartPath, viewPath, type ExplorerSpace } from '../paths';
import type { OpenView } from './useOpenView';
import type { ViewPanel } from './useViewPanel';
import { DeleteViewDialog, RenameViewDialog, SaveViewDialog } from './ViewDialogs';
import { canvasContents } from './views';

interface ExplorerViewDialogsProps {
  modelId: string;
  space: ExplorerSpace;
  shownAsked: readonly string[];
  views: ViewPanel;
  openView: OpenView;
  /** What the canvas shows, and its focused element: Save as view saves them. */
  hood: Neighbourhood | undefined;
  element: ModelElement | undefined;
  hasOwnId: (relationshipId: string) => boolean;
  groupBy: string | undefined;
  groupChoices: readonly GroupByChoice[];
  onAnnounce: (text: string) => void;
}

/** The view dialog open, if any: Save as view, Rename view or Delete view. */
export function ExplorerViewDialogs({
  modelId,
  space,
  shownAsked,
  views,
  openView,
  hood,
  element,
  hasOwnId,
  groupBy,
  groupChoices,
  onAnnounce,
}: ExplorerViewDialogsProps) {
  const navigate = useNavigate();
  const { viewDialog, setViewDialog, refreshViews } = views;
  return (
    <>
      {viewDialog === 'save' && hood && element && (
        <SaveViewDialog
          modelId={modelId}
          initialName={element.name}
          contents={canvasContents(hood, hasOwnId)}
          groupBy={
            groupBy !== undefined && groupChoices.some((choice) => choice.key === groupBy)
              ? groupBy
              : undefined
          }
          onCancel={() => {
            setViewDialog(null);
            views.focusInPanel(views.saveViewButton);
          }}
          onSaved={(saved: StoredView) => {
            setViewDialog(null);
            refreshViews();
            views.setViewHeadingFocus(true);
            onAnnounce(
              `Saved the view “${saved.name}”${saved.folder === null ? '' : ` in “${saved.folder}”`}: ${counted(saved.elementIds.length, 'element')}, ${counted(saved.relationshipIds.length, 'relationship')}.`,
            );
            void navigate(viewPath(modelId, saved.id, space, shownAsked));
          }}
        />
      )}
      {viewDialog === 'rename' && openView.view && (
        <RenameViewDialog
          modelId={modelId}
          view={openView.view}
          onCancel={() => {
            setViewDialog(null);
            requestAnimationFrame(() => views.renameButton.current?.focus());
          }}
          onRenamed={(renamed) => {
            openView.renamed(renamed);
            setViewDialog(null);
            refreshViews();
            onAnnounce(`Renamed to “${renamed.name}”.`);
            requestAnimationFrame(() => views.renameButton.current?.focus());
          }}
        />
      )}
      {viewDialog === 'delete' && openView.view && (
        <DeleteViewDialog
          modelId={modelId}
          view={openView.view}
          onCancel={() => {
            setViewDialog(null);
          }}
          onDeleted={(already) => {
            const name = openView.view?.name ?? '';
            setViewDialog(null);
            refreshViews();
            onAnnounce(already ? 'The view was already deleted.' : `Deleted the view “${name}”.`);
            // In place of the view's entry, so Back doesn't open a deleted view.
            views.leaveViewFor(modelStartPath(modelId, space, shownAsked), true);
          }}
          onReload={() => {
            setViewDialog(null);
            openView.reload();
          }}
        />
      )}
    </>
  );
}
