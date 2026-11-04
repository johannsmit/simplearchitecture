import {
  brandThemes,
  formatRatio,
  type BrandTheme,
  type BrandTokens,
  type BrandValueReport,
} from '@simplearchitecture/shared';
import type { ReactNode } from 'react';
import { previewStyle } from '../../branding';
import { BrandMark, Icon } from '../../icons';

const themeLabel: Record<BrandTheme, string> = { light: 'Light', dark: 'Dark' };

/** One theme's picture of the app with the draft tokens. */
function PreviewFigure(props: { theme: BrandTheme; tokens: BrandTokens; logoSrc: string | null }) {
  return (
    <figure className={`pv ${props.theme}`} style={previewStyle(props.tokens, props.theme)}>
      <figcaption>{themeLabel[props.theme]}</figcaption>
      {/* A picture: nothing in it can be focused or clicked. */}
      <div className="pv-frame" inert>
        <div className="app-header">
          <span className="brand">
            {props.logoSrc === null ? (
              <BrandMark />
            ) : (
              <img className="brand-logo" src={props.logoSrc} alt="" draggable={false} />
            )}
            <span className="brand-title">SimpleArchitecture</span>
          </span>
        </div>
        <div className="pv-body">
          <ul className="spaces">
            <li>
              <a aria-current="page">
                <Icon name="eye" />
                Viewing
              </a>
            </li>
            <li>
              <a>
                <Icon name="pencil" />
                Modelling
              </a>
            </li>
          </ul>
          <div className="pv-line">
            <span className="btn primary">Save</span>
            <a className="pv-link">Open in Modelling</a>
          </div>
          <div className="admin-nav">
            <ul>
              <li>
                <a>Models</a>
              </li>
              <li>
                <a>Database</a>
              </li>
              <li>
                <a aria-current="page">Branding</a>
              </li>
            </ul>
          </div>
          <ul className="pv-tree">
            <li>
              <span className="telem colour-gray">
                <span className="pv-sw" />
                Billing Service
              </span>
            </li>
            <li className="is-selected">
              <span className="telem colour-gray">
                <span className="pv-sw" />
                Order Service
              </span>
            </li>
          </ul>
          <div className="pv-canvas">
            <div className="pv-draw">
              <svg width="272" height="96" viewBox="0 0 272 96" aria-hidden="true">
                <path className="e-lit" d="M124 28H150" />
                <path className="m-lit" d="M150 23l8 5-8 5z" />
                <path className="e" d="M68 46V64" />
                <path className="m" d="M63 60l5 8 5-8z" />
              </svg>
              <span className="pv-card colour-gray is-focused" style={{ left: 12, top: 10 }}>
                Order Service
              </span>
              <span className="pv-card colour-gray" style={{ left: 158, top: 10 }}>
                Payments
              </span>
              <span className="pv-card colour-gray" style={{ left: 12, top: 68 }}>
                Ledger
              </span>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}

function Swatch({ colour }: { colour: string }) {
  return <span className="ct-sw" style={{ background: colour }} />;
}

function Value(props: { report: BrandValueReport; note: ReactNode }) {
  const { value, ratio } = props.report;
  if (value === null) return <>{props.note}</>;
  return (
    <>
      <Swatch colour={value} />
      <code>{value}</code>
      {ratio !== null && <b>{formatRatio(ratio)}</b>}
      {props.note}
    </>
  );
}

function adjustedNote(report: BrandValueReport, unset: string): ReactNode {
  if (report.entered === null) return <small>{unset}</small>;
  if (!report.adjusted) return <small>As entered</small>;
  return (
    <small className="adj">
      <Icon name="info" size="sm" />
      Adjusted from {report.entered}
    </small>
  );
}

/** The contrast table: everything the previews show in colour, as text. */
function ContrastTable({ tokens }: { tokens: BrandTokens }) {
  const rows: { use: string; target: string; cell: (theme: BrandTheme) => ReactNode }[] = [
    {
      use: 'Accent',
      target: 'Text and controls, 4.5:1',
      cell: (theme) => {
        const report = tokens.report[theme].accent;
        return <Value report={report} note={adjustedNote(report, 'Neutral')} />;
      },
    },
    {
      use: 'Text on buttons',
      target: '4.5:1',
      cell: (theme) => <Value report={tokens.report[theme].onAccent} note={null} />,
    },
    {
      use: 'Header line',
      target: '3:1',
      cell: (theme) => {
        const report = tokens.report[theme].brandLine;
        return report.value === null ? (
          <small>None</small>
        ) : (
          <Value report={report} note={adjustedNote(report, 'None')} />
        );
      },
    },
    {
      use: 'Selected row tint',
      target: 'Accent text on it, 4.5:1',
      cell: (theme) => <Value report={tokens.report[theme].selectSoft} note={null} />,
    },
  ];
  return (
    <>
      <h3 className="ct-title" id="contrast-title">
        Contrast
      </h3>
      <table className="ct" aria-labelledby="contrast-title">
        <thead>
          <tr>
            <th scope="col">Use</th>
            <th scope="col">Light</th>
            <th scope="col">Dark</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.use}>
              <th scope="row">
                {row.use}
                <small>{row.target}</small>
              </th>
              {brandThemes.map((theme) => (
                <td key={theme} data-theme-label={themeLabel[theme]}>
                  {row.cell(theme)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function BrandingPreview(props: { tokens: BrandTokens; logoSrc: string | null }) {
  return (
    <section className="table-card brand-card brand-preview-card" aria-labelledby="preview-title">
      <h2 id="preview-title">Preview</h2>
      <p className="brand-hint">
        How your changes look. Nothing changes for others until you save.
      </p>
      <div className="pv-grid">
        {brandThemes.map((theme) => (
          <PreviewFigure key={theme} theme={theme} tokens={props.tokens} logoSrc={props.logoSrc} />
        ))}
      </div>
      <ContrastTable tokens={props.tokens} />
    </section>
  );
}
