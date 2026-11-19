import type { DataListName } from '@simplearchitecture/shared';
import type { ReactNode } from 'react';

/**
 * A list of data's name on one relationship ("Order system to Warehouse"), in `<bdi>` so a
 * right-to-left element name doesn't turn it round. A cut name shows as cut, while screen readers
 * get the full name; the full name shows on hover only when something was cut (`title`).
 */
export function DataListLabel({ name }: { name: DataListName }): ReactNode {
  if (!name.cut) return <bdi>{name.full}</bdi>;
  return (
    <span title={name.full}>
      <span aria-hidden="true">
        <bdi>{name.shown}</bdi>
      </span>
      <span className="vh">{name.full}</span>
    </span>
  );
}
