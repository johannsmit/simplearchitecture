import { describe, expect, it } from 'vitest';
import { decodeXmlText, defaultXmlLimits, parseXml, XmlRejectedError } from '../src/oef/xml.js';
import { expectGrowthBelow } from './growth.js';

const xxe = `<?xml version="1.0"?>
<!DOCTYPE model [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<model><name>&secret;</name></model>`;

const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
  <!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
]>
<model><name>&lol9;</name></model>`;

function rejection(xml: string, limits = defaultXmlLimits): string {
  try {
    parseXml(xml, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(XmlRejectedError);
    return (error as Error).message;
  }
  throw new Error('expected the XML to be rejected');
}

describe('parseXml: attacks', () => {
  it('rejects an XXE sample (external entity) without reading the file', () => {
    const message = rejection(xxe);
    expect(message).toBe('XML with a DOCTYPE declaration is not accepted.');
    expect(message).not.toContain('root:');
  });

  it('rejects a billion-laughs sample quickly, without expanding anything', async () => {
    expect(rejection(billionLaughs)).toBe('XML with a DOCTYPE declaration is not accepted.');
    // It costs about what a DOCTYPE with no entities does: nothing was expanded.
    await expectGrowthBelow(
      (xml: string) => () => {
        // Often enough to measure: this is quick.
        for (let i = 0; i < 200; i++) rejection(xml);
      },
      '<!DOCTYPE model><model/>',
      billionLaughs,
    );
  });

  it.each([
    ['lower-case doctype', '<!doctype model><model/>'],
    ['an internal DTD after a comment', '<!-- hi --><!DOCTYPE model []><model/>'],
    ['a doctype after the root (still refused)', '<model/><!DOCTYPE x>'],
  ])('rejects %s', (_name, xml) => {
    expect(rejection(xml)).toContain('DOCTYPE');
  });

  it('rejects other declarations, such as a stray ENTITY', () => {
    expect(rejection('<model><!ENTITY x "y"></model>')).toBe(
      'XML declarations such as <!ENTITY> are not accepted.',
    );
  });

  it('never expands undeclared entity references', () => {
    const parsed = parseXml('<model><name>&ext;&#0;</name></model>');
    expect(parsed).toEqual({ model: { name: ['&ext;&#0;'] } });
  });

  it('does not interpret a DOCTYPE inside a comment or CDATA', () => {
    const parsed = parseXml(
      '<model><!-- <!DOCTYPE x> --><name><![CDATA[<!DOCTYPE y>]]></name></model>',
    );
    expect(parsed).toEqual({ model: { name: ['<!DOCTYPE y>'] } });
  });
});

describe('parseXml: limits', () => {
  const limits = { maxBytes: 1000, maxDepth: 3, maxElements: 5 };

  it('rejects a document over the size limit', () => {
    expect(rejection(`<model>${'x'.repeat(1000)}</model>`, limits)).toBe(
      'The XML is larger than 1000 bytes.',
    );
  });

  it('counts the size in UTF-8 bytes', () => {
    // 400 characters, 1200 bytes.
    expect(rejection(`<m>${'€'.repeat(400)}</m>`, limits)).toContain('larger than');
  });

  it('rejects nesting deeper than the limit', () => {
    expect(parseXml('<a><b><c/></b></a>', limits)).toBeDefined();
    expect(rejection('<a><b><c><d/></c></b></a>', limits)).toBe(
      'The XML is nested deeper than 3 levels.',
    );
  });

  it('rejects more elements than the limit', () => {
    expect(parseXml('<a><b/><b/><b/><b/></a>', limits)).toBeDefined();
    expect(rejection('<a><b/><b/><b/><b/><b/></a>', limits)).toBe(
      'The XML has more than 5 elements.',
    );
  });

  it('has defaults that fit a real OEF file of a few MB', () => {
    expect(defaultXmlLimits).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxDepth: 64,
      maxElements: 500_000,
    });
  });

  it('stays fast on a deep document at the default limit', () => {
    const deep = `${'<a>'.repeat(64)}${'</a>'.repeat(64)}`;
    expect(parseXml(deep)).toBeDefined();
    expect(rejection(`${'<a>'.repeat(10_000)}${'</a>'.repeat(10_000)}`)).toContain('deeper');
  });
});

describe('parseXml: well-formedness', () => {
  it.each([
    ['an unclosed element', '<model><name></model>', 'expected </name> but found </model>'],
    ['a missing end tag', '<model><name>', '<name> is not closed'],
    ['an unexpected end tag', '<model/></model>', 'unexpected end tag </model>'],
    ['two root elements', '<model/><model/>', 'more than one root element'],
    ['text outside the root', '<model/>trailing', 'text outside the root element'],
    ['no root element', '<?xml version="1.0"?>', 'no root element'],
    ['an empty document', '', 'no root element'],
    ['an unquoted attribute', '<model a=1/>', 'a malformed tag or attribute'],
    ['a duplicate attribute', '<model a="1" a="2"/>', 'duplicate attribute a'],
    ['an unterminated comment', '<model><!-- </model>', 'unterminated comment'],
    ['an unterminated tag', '<model', 'unterminated tag'],
  ])('rejects %s', (_name, xml, problem) => {
    expect(rejection(xml)).toBe(`The XML is not well-formed: ${problem}.`);
  });
});

describe('parseXml: reading', () => {
  it('removes namespace prefixes and keeps attributes', () => {
    const parsed = parseXml(
      '<?xml version="1.0"?><model xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="m1">' +
        '<element identifier="e1" xsi:type="Goal"><name xml:lang="en">Grow</name></element></model>',
    );
    expect(parsed).toEqual({
      model: {
        '@_identifier': 'm1',
        element: [
          { '@_identifier': 'e1', '@_type': 'Goal', name: [{ '#text': 'Grow', '@_lang': 'en' }] },
        ],
      },
    });
  });

  it('allows > inside attribute values', () => {
    expect(parseXml('<model note="a > b"/>')).toEqual({ model: { '@_note': 'a > b' } });
  });

  it('decodes only the predefined entities and character references', () => {
    expect(decodeXmlText('Fish &amp; chips &lt;3 &quot;x&quot; &apos;y&apos; &gt;')).toBe(
      'Fish & chips <3 "x" \'y\' >',
    );
    expect(decodeXmlText('&#233;&#x1F35E;')).toBe('é🍞');
    expect(decodeXmlText('&nbsp; &custom; &#x110000; &amp')).toBe(
      '&nbsp; &custom; &#x110000; &amp',
    );
  });
});

describe('parseXml: more attacks', () => {
  it.each([
    [
      'a parameter entity',
      '<!DOCTYPE m [<!ENTITY % p SYSTEM "http://127.0.0.1:1/x.dtd"> %p;]><model/>',
    ],
    [
      'an external DTD by public id',
      '<!DOCTYPE m PUBLIC "-//X//EN" "http://127.0.0.1:1/x.dtd"><model/>',
    ],
    [
      'a DOCTYPE after a processing instruction',
      '<?xml version="1.0"?><?pi x?><!DOCTYPE m []><model/>',
    ],
    [
      'a DOCTYPE after a comment, a PI and whitespace',
      '<!-- c --> <?pi x?>\n\t<!DOCTYPE m []><model/>',
    ],
    ['a DOCTYPE after a byte order mark', '﻿<!DOCTYPE m []><model/>'],
    ['a DOCTYPE in mixed case inside the root', '<model><!DocType m []></model>'],
  ])('rejects %s', (_name, xml) => {
    expect(rejection(xml)).toBe('XML with a DOCTYPE declaration is not accepted.');
  });

  it.each([
    ['<!ELEMENT>', '<model><!ELEMENT a ANY></model>'],
    ['<!ATTLIST>', '<model><!ATTLIST a b CDATA "x"></model>'],
    ['a broken comment opener', '<model><!- x --></model>'],
  ])('rejects %s', (_name, xml) => {
    expect(rejection(xml)).toBe('XML declarations such as <!ENTITY> are not accepted.');
  });

  it('cannot hide markup from the check in a processing instruction or CDATA', () => {
    expect(rejection('<model><?pi a="?>"<!DOCTYPE m []>"?></model>')).toContain('DOCTYPE');
    expect(
      parseXml('<model><name><![CDATA[<element identifier="x"/>&x;]]></name></model>'),
    ).toEqual({
      model: { name: ['<element identifier="x"/>&x;'] },
    });
    expect(rejection('<![CDATA[x]]><model/>')).toContain('CDATA outside the root element');
  });

  it('never touches object prototypes, whatever the element or attribute names', () => {
    expect(() =>
      parseXml('<model><__proto__><polluted>yes</polluted></__proto__></model>'),
    ).toThrow(XmlRejectedError);
    expect(parseXml('<model __proto__="x" constructor="y"/>')).toEqual({
      model: { '@___proto__': 'x', '@_constructor': 'y' },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('leaves XInclude and schema locations as plain, unfetched attributes', () => {
    expect(
      parseXml(
        '<model xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd" parse="text"/></model>',
      ),
    ).toEqual({ model: { include: { '@_href': 'file:///etc/passwd', '@_parse': 'text' } } });
  });

  it('accepts a UTF-8 byte order mark and refuses UTF-16 read as UTF-8, saying to use UTF-8', () => {
    expect(parseXml('﻿<?xml version="1.0"?><model identifier="m"/>')).toEqual({
      model: { '@_identifier': 'm' },
    });
    for (const encoding of ['utf16le', 'ucs2'] as const) {
      const utf16 = Buffer.from('﻿<model/>', encoding).toString('utf8');
      expect(rejection(utf16)).toContain('Save the file as UTF-8');
    }
    // Without a BOM, and big-endian.
    const noBom = Buffer.from('<?xml version="1.0"?><model/>', 'utf16le').toString('utf8');
    expect(rejection(noBom)).toContain('Save the file as UTF-8');
    const bigEndian = Buffer.from([0xfe, 0xff, 0x00, 0x3c]).toString('utf8');
    expect(rejection(bigEndian)).toContain('Save the file as UTF-8');
    // Declared as UTF-16 (the body is always read as UTF-8).
    expect(rejection('<?xml version="1.0" encoding="UTF-16"?><model/>')).toContain(
      'Save the file as UTF-8',
    );
    expect(parseXml('<?xml version="1.0" encoding="utf-8"?><model/>')).toEqual({ model: '' });
  });
});

describe('parseXml: pathological input stays linear', () => {
  const size = 4 * 1024 * 1024;
  it.each([
    ['unterminated quotes', `<a b="x' `],
    ['lone <', '<'],
    ['tags without >', '<a '],
    ['unterminated comments', '<!--'],
    ['unterminated processing instructions', '<?'],
    ['unquoted attributes', 'x= '],
  ])('rejects 4 MB of %s in linear time', async (_name, unit) => {
    const xmlOf = (bytes: number) => `<model>${unit.repeat(Math.floor(bytes / unit.length))}`;
    const inputs = new Map([size / 4, size].map((bytes) => [bytes, xmlOf(bytes)]));
    await expectGrowthBelow(
      (bytes: number) => () => rejection(inputs.get(bytes) ?? ''),
      size / 4,
      size,
    );
  });

  // A start tag with about a million attributes and a malformed end overflows the regex
  // engine's backtracking stack, so a RangeError escapes and the route answers 500, not 400.
  it('rejects an attribute-heavy malformed tag with XmlRejectedError', () => {
    expect(rejection(`<model ${'a="x" '.repeat(1_200_000)} ! />`)).toContain('not well-formed');
  });

  // Messages quote tag and attribute names in full, so a 5 MB tag name comes back in the
  // 400 body and goes into the log.
  it('keeps error messages short, whatever the names in the XML', () => {
    const long = 'A'.repeat(100_000);
    for (const xml of [
      `<model><${long}></model>`,
      `<model ${long}="1" ${long}="2"/>`,
      `<model></${long}>`,
      `<${long}>`,
    ]) {
      expect(rejection(xml).length).toBeLessThan(300);
    }
  });
});
