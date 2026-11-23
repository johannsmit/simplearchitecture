import { displayLabel, type ModelGraph, type ModelRelationship } from '@simplearchitecture/shared';
import { EdgeSample } from '../../../metamodel-ui';
import { relationshipSentence } from '../../../modelling/relationships';

/** The chooser for a line that holds several relationships. */
export function EdgeMenu({
  menu,
  graph,
  relationshipById,
  onClose,
  onOpen,
}: {
  menu: { ids: string[]; top: number; left: number };
  graph: ModelGraph;
  relationshipById: ReadonlyMap<string, ModelRelationship>;
  onClose: () => void;
  /** A relationship chosen: the menu closes first. */
  onOpen: (id: string) => void;
}) {
  return (
    <div
      className="related-pop edge-menu"
      role="menu"
      aria-label={`${menu.ids.length} relationships`}
      style={{ top: menu.top, left: menu.left }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <p className="rp-title">{menu.ids.length} relationships</p>
      {menu.ids.map((id) => {
        const relationship = relationshipById.get(id);
        if (!relationship) return null;
        const label = displayLabel(relationship, graph);
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            className="rp-item"
            onClick={() => {
              onClose();
              onOpen(id);
            }}
          >
            <EdgeSample type={relationship.type} twoWay={relationship.twoWay === true} />
            <span>
              {relationshipSentence(graph, relationship)}
              {label !== undefined && <span className="rp-label"> &ldquo;{label}&rdquo;</span>}
            </span>
            {relationship.architectureState !== 'Current' && (
              <span className="tag">{relationship.architectureState}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
