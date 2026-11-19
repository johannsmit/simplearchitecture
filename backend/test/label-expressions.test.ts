import {
  buildModelGraph,
  displayLabel,
  fillLabel,
  insertLabelName,
  labelNameAt,
  labelPropertyNames,
  type JgfDocument,
  type LabelSubject,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// Property values in relationship labels. Made-up data only.

const relation = (metadata: Record<string, unknown> = {}): LabelSubject => ({
  type: 'Relation',
  architectureState: 'Current',
  metadata,
});

const fill = (label: string, subject: LabelSubject = relation(), names: string[] = []) =>
  fillLabel(label, subject, names);

describe('fillLabel', () => {
  it('fills in the standard properties by the names the form shows, ignoring case', () => {
    const subject: LabelSubject = {
      type: 'Relation',
      architectureState: 'Target',
      metadata: {
        identity: 'Made-up service account',
        identityContext: 'Original user id',
        sourceToTargetData: 'Seed orders',
        description: 'Sends the\n  nightly batch',
      },
    };
    expect(fill('{Identity} {Source to Target Data}', subject).text).toBe(
      'Made-up service account Seed orders',
    );
    expect(fill('{identity context}', subject).text).toBe('Original user id');
    expect(fill('{IDENTITY   Context}', subject).text).toBe('Original user id');
    expect(fill('{ Architecture state }', subject).text).toBe('Target');
    expect(fill('{Description}', subject).text).toBe('Sends the nightly batch');
    expect(fill('Sends {source to target data} as {identity}', subject)).toEqual({
      text: 'Sends Seed orders as Made-up service account',
      unknown: [],
    });
  });

  it('reads Architecture state as Current when none is stored', () => {
    expect(fill('{Architecture state}').text).toBe('Current');
  });

  it('fills in custom metadata by its own name, ignoring case, an exact match first', () => {
    const subject = relation({
      protocol: 'HTTPS',
      port: 443,
      secure: true,
      Owner: 'A',
      owner: 'b',
    });
    expect(fill('{Protocol} on {port}, {secure}', subject).text).toBe('HTTPS on 443, true');
    expect(fill('{owner}/{Owner}/{OWNER}', subject).text).toBe('b/A/A');
  });

  it('gives nothing for a missing or empty value, closing up the spaces around it', () => {
    const subject = relation({ sourceToTargetData: 'Orders', identity: '   ' });
    expect(fill('{Identity} {Source to Target Data}', subject).text).toBe('Orders');
    expect(fill('{Source to Target Data} {Identity}', subject).text).toBe('Orders');
    expect(fill('Sends  {Identity}  {Source to Target Data}', subject).text).toBe('Sends Orders');
    expect(fill('{Source to Target Data}{Identity}{Source to Target Data}', subject).text).toBe(
      'OrdersOrders',
    );
    expect(fill('as {Identity Context} {Identity}', subject).text).toBe('as');
    expect(fill('{Identity} {Identity Context}', subject)).toEqual({ text: '', unknown: [] });
  });

  it('leaves the spaces typed between other parts as they are', () => {
    expect(fill('A  B {Source to Target Data}', relation({ sourceToTargetData: 'C' })).text).toBe(
      'A  B C',
    );
  });

  it('gives nothing for a list or an object, which has no one value', () => {
    const subject = relation({ tags: ['a', 'b'], detail: { a: 1 } });
    expect(fill('x {tags} {detail} y', subject).text).toBe('x y');
  });

  it('leaves an unknown name as typed, and lists it once', () => {
    expect(fill('{Dtaa} and {Dtaa} via { Protocl }', relation())).toEqual({
      text: '{Dtaa} and {Dtaa} via { Protocl }',
      unknown: ['Dtaa', 'Protocl'],
    });
  });

  it('knows custom metadata names the model uses, though this relationship has none', () => {
    expect(
      fill('{protocol} {Source to Target Data}', relation({ sourceToTargetData: 'Orders' }), [
        'protocol',
      ]),
    ).toEqual({
      text: 'Orders',
      unknown: [],
    });
  });

  it('takes the names of the relationship type: a Contains has no Identity or Data fields', () => {
    const contains: LabelSubject = {
      type: 'Contains',
      architectureState: 'Current',
      metadata: { description: 'Holds it' },
    };
    expect(fill('{Source to Target Data} {Description}', contains)).toEqual({
      text: '{Source to Target Data} Holds it',
      unknown: ['Source to Target Data'],
    });
    // A Contains can hold such a key as custom metadata, which reads by its own name and the
    // standard one.
    const kept = { ...contains, metadata: { sourceToTargetData: 'Kept' } };
    expect(fill('{sourceToTargetData}', kept).text).toBe('Kept');
    expect(fill('{Source to Target Data}', kept).text).toBe('Kept');
  });

  it('fills in the values of Source to target data and Target to source data joined by ", "', () => {
    const subject = relation({
      sourceToTargetData: ['Orders', ' Invoices ', '', 'Order\n lines'],
      targetToSourceData: ['Order ids'],
    });
    expect(fill('Sends {Source to Target Data}, gets {Target to Source Data}', subject).text).toBe(
      'Sends Orders, Invoices, Order lines, gets Order ids',
    );
    // An empty list, or one of blanks, gives nothing, and the spaces around it close up.
    expect(
      fill('Sends {Source to Target Data} now', relation({ sourceToTargetData: [] })).text,
    ).toBe('Sends now');
    expect(fill('{Target to Source Data}', relation({ targetToSourceData: ['  '] })).text).toBe('');
    // A single text, as stored before, is one value; another shape gives nothing.
    expect(fill('{Source to Target Data}', relation({ sourceToTargetData: 'Orders' })).text).toBe(
      'Orders',
    );
    expect(fill('{Source to Target Data}', relation({ sourceToTargetData: { a: 1 } })).text).toBe(
      '',
    );
    // Kept on a Contains, a list reads by both names too.
    const kept: LabelSubject = {
      type: 'Contains',
      architectureState: 'Current',
      metadata: { sourceToTargetData: ['Kept', 'Too'] },
    };
    expect(fill('{Source to Target Data}', kept).text).toBe('Kept, Too');
    expect(fill('{sourceToTargetData}', kept).text).toBe('Kept, Too');
  });

  it('never reads the type or internal keys', () => {
    const subject = relation({ type: 'Relation', 'simplearchitecture:stored': 'x' });
    expect(fill('{type}', subject).unknown).toEqual(['type']);
    expect(fill('{simplearchitecture:stored}', subject).unknown).toEqual([
      'simplearchitecture:stored',
    ]);
  });

  it('gives literal braces for {{ and }}', () => {
    const subject = relation({ sourceToTargetData: 'Orders' });
    expect(fill('{{Source to Target Data}}', subject).text).toBe('{Source to Target Data}');
    expect(fill('{{{Source to Target Data}}}', subject).text).toBe('{Orders}');
    expect(fill('a {{ b }} c', subject).text).toBe('a { b } c');
    expect(fill('{{Source to Target Data}', subject).text).toBe('{Source to Target Data}');
  });

  it('leaves braces that open or close nothing as typed', () => {
    const subject = relation({ sourceToTargetData: 'Orders' });
    expect(fill('{Source to target data', subject)).toEqual({
      text: '{Source to target data',
      unknown: [],
    });
    expect(fill('Source to target data}', subject).text).toBe('Source to target data}');
    expect(fill('{} and { }', subject)).toEqual({ text: '{} and { }', unknown: [] });
    expect(fill('{a{Source to Target Data}', subject).text).toBe('{aOrders');
  });

  it('leaves a label without braces unchanged', () => {
    expect(fill('reads  from', relation({ sourceToTargetData: 'x' }))).toEqual({
      text: 'reads  from',
      unknown: [],
    });
  });

  it('keeps values that look like markup as text', () => {
    const subject = relation({
      sourceToTargetData: '<img src=x onerror=alert(1)>',
      identity: '{Source to Target Data}',
      protocol: '<b>&amp;</b>',
    });
    expect(fill('{Source to Target Data} {protocol}', subject).text).toBe(
      '<img src=x onerror=alert(1)> <b>&amp;</b>',
    );
    // A value is never filled in again.
    expect(fill('{Identity}', subject).text).toBe('{Source to Target Data}');
  });

  it('takes linear time on a long label full of braces', () => {
    const label = '{a'.repeat(50_000);
    expect(fill(label).text).toBe(label);
  });
});

describe('displayLabel', () => {
  const document: JgfDocument = {
    graph: {
      nodes: {
        a: { label: 'Made-up shop', metadata: { type: 'Application' } },
        b: { label: 'Made-up stock', metadata: { type: 'Application' } },
      },
      edges: [
        {
          id: 'r1',
          source: 'a',
          target: 'b',
          relation: 'Relation',
          label: '{Source to Target Data} {protocol}',
          metadata: { sourceToTargetData: 'Orders' },
        },
        {
          id: 'r2',
          source: 'b',
          target: 'a',
          relation: 'Relation',
          label: '{Identity}',
          metadata: { protocol: 'SFTP' },
        },
        { id: 'r3', source: 'b', target: 'a', relation: 'Relation', label: 'plain' },
      ],
    },
  };
  const graph = buildModelGraph(document);
  const [r1, r2, r3] = graph.relationships;

  it('fills in a label, and gives none when it fills in to nothing', () => {
    expect(r1 && displayLabel(r1, graph)).toBe('Orders');
    expect(r2 && displayLabel(r2, graph)).toBeUndefined();
    expect(r3 && displayLabel(r3, graph)).toBe('plain');
  });

  it('without the model, a custom name the relationship lacks stays as typed', () => {
    expect(r1 && displayLabel(r1)).toBe('Orders {protocol}');
  });

  it('gives none for a relationship without a label', () => {
    expect(displayLabel(relation())).toBeUndefined();
  });
});

describe('labelPropertyNames', () => {
  it('lists the form fields in order, then custom names once each, ignoring case', () => {
    expect(
      labelPropertyNames(relation({ protocol: 'x', type: 'Relation' }), ['Protocol', 'port']),
    ).toEqual([
      'Identity',
      'Identity Context',
      'Source to Target Data',
      'Target to Source Data',
      'Architecture state',
      'Description',
      'protocol',
      'port',
    ]);
    expect(
      labelPropertyNames({ type: 'Contains', architectureState: 'Current', metadata: {} }),
    ).toEqual(['Architecture state', 'Description']);
  });

  it('leaves out names that a label could never hold', () => {
    expect(labelPropertyNames(relation({ 'a}b': 'x' }), ['{c', ' '])).not.toContain('a}b');
  });
});

describe('labelNameAt and insertLabelName', () => {
  it('finds the name being typed after an open brace', () => {
    expect(labelNameAt('Sends {Da', 9)).toEqual({ start: 6, partial: 'Da' });
    expect(labelNameAt('{', 1)).toEqual({ start: 0, partial: '' });
    expect(labelNameAt('{Data} x', 8)).toBeUndefined();
    expect(labelNameAt('{{', 2)).toBeUndefined();
    expect(labelNameAt('no brace', 3)).toBeUndefined();
    expect(labelNameAt('{Data} {Id} x', 9)).toEqual({ start: 7, partial: 'I' });
  });

  it('puts the name in place of what is typed, with its closing brace', () => {
    expect(insertLabelName('Sends {Da', 9, 'Data')).toEqual({ label: 'Sends {Data}', caret: 12 });
    expect(insertLabelName('{Ide} x', 3, 'Identity Context')).toEqual({
      label: '{Identity Context} x',
      caret: 18,
    });
    expect(insertLabelName('{ and {Data}', 1, 'Identity')).toEqual({
      label: '{Identity} and {Data}',
      caret: 10,
    });
    expect(insertLabelName('plain', 2, 'Data')).toEqual({ label: 'plain', caret: 2 });
  });
});
