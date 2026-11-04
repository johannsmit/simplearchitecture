import {
  edgeTypes,
  nodeTypes,
  type CountsByReasonAndType,
  type JgfValidationResult,
  type OefMappingReport,
  type ValidationIssue,
} from '@simplearchitecture/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon, type IconName } from '../../icons';
import { EdgeSample, TypeMark } from '../../metamodel-ui';
import { counted, formatNumber } from '../../words';
import { elementPath } from '../paths';
import { groupIssues, issueInWords, reasonInWords } from './words';

export type SectionKey =
  | 'errors'
  | 'elements'
  | 'relationships'
  | 'functions'
  | 'skipped'
  | 'folded'
  | 'properties'
  | 'not-imported'
  | 'warnings';

export function sectionId(key: SectionKey): string {
  return `import-section-${key}`;
}

/** Opens a report section, brings it into view and moves focus to its summary. */
export function openSection(key: SectionKey): void {
  const section = document.getElementById(sectionId(key));
  if (!(section instanceof HTMLDetailsElement)) return;
  section.open = true;
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Not every DOM implements scrollIntoView (test DOMs don't).
  (section as Partial<Pick<HTMLElement, 'scrollIntoView'>>).scrollIntoView?.({
    block: 'nearest',
    behavior: reduced ? 'auto' : 'smooth',
  });
  section.querySelector('summary')?.focus();
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function skippedTotal(counts: CountsByReasonAndType): number {
  return sum(Object.values(counts).map((byType) => sum(Object.values(byType))));
}

/** Entries with a count above zero, largest first. */
function nonZeroDescending(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

interface Chip {
  key: SectionKey;
  icon: IconName;
  text: string;
  warn?: boolean;
}

/** Summary chips for the non-zero parts of the report; each opens its section. */
export function summaryChips(report: OefMappingReport | undefined, warningCount: number): Chip[] {
  const chips: Chip[] = [];
  if (warningCount > 0) {
    chips.push({
      key: 'warnings',
      icon: 'alert',
      text: counted(warningCount, 'warning'),
      warn: true,
    });
  }
  if (!report) return chips;
  const elementsSkipped = skippedTotal(report.elements.skipped);
  const relationshipsSkipped = skippedTotal(report.relationships.skipped);
  if (elementsSkipped > 0) {
    chips.push({
      key: 'skipped',
      icon: 'skip',
      text: `${counted(elementsSkipped, 'element')} skipped`,
    });
  }
  if (relationshipsSkipped > 0) {
    chips.push({
      key: 'skipped',
      icon: 'skip',
      text: `${counted(relationshipsSkipped, 'relationship')} skipped`,
    });
  }
  if (report.functions.folded > 0) {
    chips.push({
      key: 'functions',
      icon: 'fn',
      text: `${counted(report.functions.folded, 'function')} folded into ${counted(report.functions.hosts, 'element')}`,
    });
  }
  if (report.relationships.foldedEnds.count > 0) {
    chips.push({
      key: 'folded',
      icon: 'unlink',
      text: `${counted(report.relationships.foldedEnds.count, 'relationship')} lost to folded ends`,
      warn: true,
    });
  }
  return chips;
}

export function ReportChips({ chips }: { chips: Chip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="chips">
      {chips.map((chip) => (
        <button
          key={chip.text}
          type="button"
          className={chip.warn ? 'rchip warn' : 'rchip'}
          onClick={() => {
            openSection(chip.key);
          }}
        >
          <Icon name={chip.icon} size="sm" />
          {chip.text}
        </button>
      ))}
    </div>
  );
}

function Section(props: {
  id: SectionKey;
  title: string;
  summary: string;
  open?: boolean;
  one?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="sec" id={sectionId(props.id)} open={props.open}>
      <summary>
        <span className="caret">
          <Icon name="chev-right" size="sm" />
        </span>
        <b>{props.title}</b>
        <span className="sum">{props.summary}</span>
      </summary>
      <div className={props.one ? 'sec-body one' : 'sec-body'}>{props.children}</div>
    </details>
  );
}

/** A two-column table of labelled counts. Rows with a zero count are left out. */
function CountTable(props: { caption?: string; rows: [ReactNode, number, string][] }) {
  const rows = props.rows.filter(([, count]) => count > 0);
  if (rows.length === 0) return null;
  return (
    <table className="mini-table">
      {props.caption !== undefined && <caption>{props.caption}</caption>}
      <tbody>
        {rows.map(([label, count, key]) => (
          <tr key={key}>
            <td>{label}</td>
            <td className="n">{formatNumber(count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Reason → ArchiMate type → count, largest first. */
function SkippedTable({ caption, counts }: { caption: string; counts: CountsByReasonAndType }) {
  const rows = Object.entries(counts)
    .flatMap(([reason, byType]) =>
      Object.entries(byType).map(([type, count]) => ({ reason, type, count })),
    )
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return (
    <table className="mini-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Reason</th>
          <th scope="col">ArchiMate type</th>
          <th scope="col" className="n">
            Count
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={3} className="muted">
              None
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={`${row.reason}|${row.type}`}>
              <td>{reasonInWords(row.reason)}</td>
              <td>{row.type}</td>
              <td className="n">{formatNumber(row.count)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/** Issues grouped by code, each group collapsible, with an Open link when the issue names an element. */
export function IssueGroups(props: {
  issues: readonly ValidationIssue[];
  /** The saved model, so issues can link to their element. Absent when nothing was saved. */
  modelId?: string;
  severity: 'error' | 'warning';
  truncated: boolean;
  /** Open the groups by default (errors). */
  open?: boolean;
}) {
  const groups = groupIssues(props.issues);
  return (
    <div>
      {groups.map((group) => (
        <details
          key={group.code}
          className={`warn-group ${props.severity === 'error' ? 'is-error' : ''}`}
          open={props.open === true || groups.length === 1}
        >
          <summary>
            <Icon name="alert" size="sm" />
            {issueInWords(group.code)}
            <span className="count">{formatNumber(group.issues.length)}</span>
          </summary>
          <ul>
            {group.issues.map((issue, index) => (
              <li key={index}>
                {issue.message}
                {props.modelId !== undefined && issue.nodeId !== undefined && (
                  <Link to={elementPath(props.modelId, issue.nodeId)}>Open</Link>
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {props.truncated && (
        <p className="muted trunc-note">
          More {props.severity === 'error' ? 'errors' : 'warnings'} were found than are listed. The
          counts are complete.
        </p>
      )}
    </div>
  );
}

const foldedEndWords = { source: 'Source', target: 'Target', both: 'Both' } as const;

/** The sections of an OEF import report and the validation warnings. */
export function ReportSections(props: {
  report?: OefMappingReport;
  validation: JgfValidationResult;
  modelId?: string;
  /** Rejected import: the Errors section comes first and is open. */
  rejected?: boolean;
}) {
  const { report, validation, modelId } = props;
  const sections: ReactNode[] = [];

  if (props.rejected === true) {
    sections.push(
      <Section
        key="errors"
        id="errors"
        title="Errors"
        summary={`${formatNumber(validation.errorCount)} · nothing was saved`}
        open
        one
      >
        <IssueGroups
          issues={validation.errors}
          severity="error"
          truncated={validation.truncated}
          open
        />
      </Section>,
    );
  }

  if (report) {
    const created = sum(Object.values(report.elements.mapped));
    const createdRelationships = sum(Object.values(report.relationships.mapped));
    const elementsSkipped = skippedTotal(report.elements.skipped);
    const relationshipsSkipped = skippedTotal(report.relationships.skipped);
    const { functions, properties, relationships } = report;
    const byArchimateType = nonZeroDescending(report.elements.mappedByElementType);
    const foldedByType = nonZeroDescending(report.elements.folded);
    const mappedProperties = sum(Object.values(properties.mapped));
    const keptAsCustom = sum(Object.values(properties.keptAsCustom));
    const notTranslated = sum(Object.values(properties.valuesNotTranslated));

    sections.push(
      <Section
        key="elements"
        id="elements"
        title="Elements"
        summary={[
          `${formatNumber(created)} created`,
          ...nodeTypes
            .filter((type) => report.elements.mapped[type] > 0)
            .map((type) => `${type} ${formatNumber(report.elements.mapped[type])}`),
        ].join(' · ')}
      >
        <div>
          <CountTable
            caption="Created, by type"
            rows={nodeTypes.map((type) => [
              <span className="t" key={type}>
                <TypeMark type={type} />
                {type}
              </span>,
              report.elements.mapped[type],
              type,
            ])}
          />
          <p className="muted note">
            {counted(report.elements.total, 'element')} read in the file.
          </p>
        </div>
        <CountTable
          caption="Created, by ArchiMate type"
          rows={byArchimateType.map(([type, count]) => [type, count, type])}
        />
      </Section>,
      <Section
        key="relationships"
        id="relationships"
        title="Relationships"
        summary={[
          `${formatNumber(createdRelationships)} created`,
          ...edgeTypes
            .filter((type) => relationships.mapped[type] > 0)
            .map((type) => `${type} ${formatNumber(relationships.mapped[type])}`),
          `${formatNumber(relationships.total)} read`,
        ].join(' · ')}
      >
        <div>
          <CountTable
            caption="Created, by type"
            rows={edgeTypes.map((type) => [
              <span className="t" key={type}>
                <EdgeSample type={type} />
                {type}
              </span>,
              relationships.mapped[type],
              type,
            ])}
          />
          <p className="muted note">
            {counted(relationships.total, 'relationship')} read in the file.
          </p>
        </div>
      </Section>,
      <Section
        key="functions"
        id="functions"
        title="Functions"
        summary={`${formatNumber(functions.folded)} folded into ${counted(functions.hosts, 'element')} · ${formatNumber(functions.keptAsNodes.length)} kept as elements`}
      >
        <div>
          <p>
            {counted(functions.folded, 'function')}{' '}
            {functions.folded === 1 ? 'became an entry' : 'became entries'} in the Functions list of{' '}
            {counted(functions.hosts, 'element')}.
          </p>
          <CountTable
            rows={[
              ['Already listed, not added twice', functions.duplicateEntries, 'duplicates'],
              ['Names cut short', functions.entriesTruncated, 'truncated'],
              ['Not added (the limit on entries was reached)', functions.entriesNotAdded, 'cap'],
              [
                'Description or properties not carried over',
                functions.foldedWithDetailsNotCarried,
                'details',
              ],
            ]}
          />
          <CountTable
            caption="Folded, by ArchiMate type"
            rows={foldedByType.map(([type, count]) => [type, count, type])}
          />
        </div>
        <table className="mini-table">
          <caption>Kept as elements (no application to fold into)</caption>
          <tbody>
            {functions.keptAsNodes.length === 0 ? (
              <tr>
                <td className="muted">None</td>
              </tr>
            ) : (
              functions.keptAsNodes.map((kept) => (
                <tr key={kept.id}>
                  <td>
                    {modelId === undefined ? (
                      kept.name || kept.id
                    ) : (
                      <Link to={elementPath(modelId, kept.id)}>{kept.name || kept.id}</Link>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Section>,
      <Section
        key="skipped"
        id="skipped"
        title="Skipped"
        summary={`${counted(elementsSkipped, 'element')} · ${counted(relationshipsSkipped, 'relationship')}`}
      >
        <SkippedTable caption="Elements" counts={report.elements.skipped} />
        <SkippedTable caption="Relationships" counts={relationships.skipped} />
      </Section>,
      <Section
        key="folded"
        id="folded"
        title="Folded ends"
        summary={
          relationships.foldedEnds.count === 0
            ? 'None'
            : `${counted(relationships.foldedEnds.count, 'relationship')} not imported`
        }
        one
      >
        {relationships.foldedEnds.count === 0 ? (
          <p className="muted">No relationships were lost to folded functions.</p>
        ) : (
          <>
            <p>
              {counted(relationships.foldedEnds.count, 'relationship')}{' '}
              {relationships.foldedEnds.count === 1 ? "wasn't" : "weren't"} imported because one end
              is a function that was folded into an element.
            </p>
            <table className="mini-table">
              <thead>
                <tr>
                  <th scope="col">Relationship id</th>
                  <th scope="col">ArchiMate type</th>
                  <th scope="col">Folded end</th>
                </tr>
              </thead>
              <tbody>
                {relationships.foldedEnds.listed.map((row, index) => (
                  <tr key={`${row.id}|${index}`}>
                    <td className="mono">{row.id}</td>
                    <td>{row.type}</td>
                    <td>{foldedEndWords[row.end]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {relationships.foldedEnds.truncated && (
              <p className="muted">
                Showing the first {formatNumber(relationships.foldedEnds.listed.length)} of{' '}
                {formatNumber(relationships.foldedEnds.count)}.
              </p>
            )}
          </>
        )}
      </Section>,
      <Section
        key="properties"
        id="properties"
        title="Properties"
        summary={`${formatNumber(mappedProperties)} mapped · ${formatNumber(keptAsCustom)} kept as custom · ${counted(notTranslated, 'value')} not translated`}
      >
        <CountTable
          caption="Mapped to standard properties"
          rows={nonZeroDescending(properties.mapped).map(([key, count]) => [key, count, key])}
        />
        <CountTable
          caption="Of these, on relationships"
          rows={[
            ...nonZeroDescending(properties.onRelationships.mapped).map(
              ([key, count]): [ReactNode, number, string] => [`Mapped: ${key}`, count, `m|${key}`],
            ),
            ...nonZeroDescending(properties.onRelationships.defaultsApplied).map(
              ([key, count]): [ReactNode, number, string] => [
                `Defaults applied: ${key}`,
                count,
                `d|${key}`,
              ],
            ),
          ]}
        />
        <CountTable
          caption="Kept as custom metadata"
          rows={nonZeroDescending(properties.keptAsCustom).map(([key, count]) => [key, count, key])}
        />
        <CountTable
          caption="Other"
          rows={[
            ['Values translated (e.g. "Target state" → Target)', properties.valuesTranslated, 't'],
            ...nonZeroDescending(properties.valuesNotTranslated).map(
              ([key, count]): [ReactNode, number, string] => [
                `Values not translated: ${key}`,
                count,
                `nt|${key}`,
              ],
            ),
            ...nonZeroDescending(properties.defaultsApplied).map(
              ([key, count]): [ReactNode, number, string] => [
                `Defaults applied: ${key}`,
                count,
                `d|${key}`,
              ],
            ),
            ['Keys renamed (the plain name was taken)', properties.renamedKeys, 'renamed'],
            ['Values with no definition in the file', properties.unknownDefinitions, 'unknown'],
          ]}
        />
      </Section>,
      <Section
        key="not-imported"
        id="not-imported"
        title="Not imported"
        summary={`${counted(report.viewsSkipped, 'diagram')} · ${counted(report.organizationItemsSkipped, 'folder')}`}
        one
      >
        <p>
          Diagrams and folders aren&apos;t imported yet: {counted(report.viewsSkipped, 'diagram')}{' '}
          and {counted(report.organizationItemsSkipped, 'folder')} were left out.
        </p>
      </Section>,
    );
  }

  sections.push(
    <Section
      key="warnings"
      id="warnings"
      title="Warnings"
      summary={
        validation.warningCount === 0
          ? 'None'
          : `${formatNumber(validation.warningCount)}${props.rejected === true ? '' : ' · the model was saved'}`
      }
      open={validation.warningCount > 0 && props.rejected !== true}
      one
    >
      {validation.warningCount === 0 ? (
        <p className="muted">No warnings.</p>
      ) : (
        <IssueGroups
          issues={validation.warnings}
          severity="warning"
          truncated={validation.truncated}
          {...(modelId === undefined ? {} : { modelId })}
        />
      )}
    </Section>,
  );

  return <div className="sections">{sections}</div>;
}
