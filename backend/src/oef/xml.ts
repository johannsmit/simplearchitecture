import { XMLParser } from 'fast-xml-parser';

export interface XmlLimits {
  /** Largest document, in UTF-8 bytes. */
  maxBytes: number;
  /** Deepest element nesting. */
  maxDepth: number;
  /** Most elements in one document. */
  maxElements: number;
}

/** OEF files are a few MB; a real model is far below these limits. */
export const defaultXmlLimits: XmlLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxDepth: 64,
  maxElements: 500_000,
};

/** The XML was refused. The message is safe to show to the user. */
export class XmlRejectedError extends Error {
  override name = 'XmlRejectedError';
}

function notWellFormed(problem: string): XmlRejectedError {
  return new XmlRejectedError(`The XML is not well-formed: ${problem}.`);
}

/** Cuts a name from the input short, so a huge name never makes a huge message or log line. */
export function shortName(name: string, max = 80): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/** A character allowed in a tag or attribute name by this (deliberately simple) check. */
function isNameChar(c: string): boolean {
  return (
    c !== '' &&
    !isSpace(c) &&
    c !== '/' &&
    c !== '>' &&
    c !== '"' &&
    c !== "'" &&
    c !== '=' &&
    c !== '<'
  );
}

/**
 * Reads the tag from `start` ('<') to `end` ('>') without regular expressions (which can overflow
 * on huge tags), visiting each character a bounded number of times.
 */
function readTag(
  xml: string,
  start: number,
  end: number,
): { kind: 'end'; name: string } | { kind: 'start'; name: string; selfClosing: boolean } {
  const malformed = (): XmlRejectedError => notWellFormed('a malformed tag or attribute');
  const skipSpaces = (from: number): number => {
    let k = from;
    while (k < end && isSpace(xml.charAt(k))) k += 1;
    return k;
  };
  const readName = (from: number): number => {
    let k = from;
    while (k < end && isNameChar(xml.charAt(k))) k += 1;
    return k;
  };

  if (xml.charAt(start + 1) === '/') {
    const nameEnd = readName(start + 2);
    if (nameEnd === start + 2 || skipSpaces(nameEnd) !== end) throw malformed();
    return { kind: 'end', name: xml.slice(start + 2, nameEnd) };
  }

  const nameEnd = readName(start + 1);
  if (nameEnd === start + 1) throw malformed();
  const name = xml.slice(start + 1, nameEnd);
  const seen = new Set<string>();
  let k = nameEnd;
  for (;;) {
    const afterSpace = skipSpaces(k);
    if (afterSpace === end) return { kind: 'start', name, selfClosing: false };
    if (xml.charAt(afterSpace) === '/') {
      if (afterSpace + 1 !== end) throw malformed();
      return { kind: 'start', name, selfClosing: true };
    }
    // Attributes are separated by whitespace: name = "value" or 'value', without '<'.
    if (afterSpace === k) throw malformed();
    const attributeEnd = readName(afterSpace);
    if (attributeEnd === afterSpace) throw malformed();
    const attribute = xml.slice(afterSpace, attributeEnd);
    let v = skipSpaces(attributeEnd);
    if (xml.charAt(v) !== '=') throw malformed();
    v = skipSpaces(v + 1);
    const quote = xml.charAt(v);
    if (quote !== '"' && quote !== "'") throw malformed();
    let close = v + 1;
    for (; close < end && xml.charAt(close) !== quote; close += 1) {
      if (xml.charAt(close) === '<') throw malformed();
    }
    if (close >= end) throw malformed();
    if (seen.has(attribute)) throw notWellFormed(`duplicate attribute ${shortName(attribute)}`);
    seen.add(attribute);
    k = close + 1;
  }
}

/** UTF-16 read as UTF-8 shows NUL characters (or two replacement characters for its BOM). */
function checkEncoding(xml: string): void {
  const head = xml.slice(0, 1024);
  const declared = /^\uFEFF?<\?xml[^>]*?encoding\s*=\s*["']([^"']{1,40})["']/i.exec(head)?.[1];
  if (
    head.includes('\u0000') ||
    head.startsWith('\uFFFD\uFFFD') ||
    (declared !== undefined && /^(utf|ucs)-?(16|32|2|4)/i.test(declared))
  ) {
    throw new XmlRejectedError(
      'The XML is encoded as UTF-16 (or UTF-32). Save the file as UTF-8 and try again.',
    );
  }
}

/**
 * A strict, linear check before any parsing (the parser itself is lenient). Refuses DOCTYPE and
 * every other `<!` declaration, so there is no DTD, no entity definition and no external entity.
 * Checks that tags are well-formed and balanced with one root element, and enforces the depth and
 * element limits. Comments, CDATA and processing instructions are skipped, never interpreted.
 */
function checkXml(xml: string, limits: XmlLimits): void {
  const open: string[] = [];
  let elements = 0;
  let rootClosed = false;
  let i = 0;

  const skipTo = (from: number, terminator: string, what: string): number => {
    const end = xml.indexOf(terminator, from);
    if (end === -1) throw notWellFormed(`unterminated ${what}`);
    return end + terminator.length;
  };

  while (i < xml.length) {
    const next = xml.indexOf('<', i);
    const textEnd = next === -1 ? xml.length : next;
    if (open.length === 0 && xml.slice(i, textEnd).trim() !== '') {
      throw notWellFormed('text outside the root element');
    }
    if (next === -1) break;
    i = next;

    if (xml.startsWith('<!--', i)) {
      i = skipTo(i + 4, '-->', 'comment');
    } else if (xml.startsWith('<![CDATA[', i)) {
      if (open.length === 0) throw notWellFormed('CDATA outside the root element');
      i = skipTo(i + 9, ']]>', 'CDATA section');
    } else if (xml.startsWith('<?', i)) {
      i = skipTo(i + 2, '?>', 'processing instruction');
    } else if (xml.startsWith('<!', i)) {
      throw new XmlRejectedError(
        xml.slice(i, i + 9).toLowerCase() === '<!doctype'
          ? 'XML with a DOCTYPE declaration is not accepted.'
          : 'XML declarations such as <!ENTITY> are not accepted.',
      );
    } else {
      // Find the tag's '>' outside quoted attribute values.
      let j = i + 1;
      for (let quote = ''; j < xml.length; j += 1) {
        const c = xml.charAt(j);
        if (quote !== '') {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '>') {
          break;
        }
      }
      if (j >= xml.length) throw notWellFormed('unterminated tag');
      const tag = readTag(xml, i, j);
      i = j + 1;

      if (tag.kind === 'end') {
        const expected = open.pop();
        if (expected !== tag.name) {
          throw notWellFormed(
            expected === undefined
              ? `unexpected end tag </${shortName(tag.name)}>`
              : `expected </${shortName(expected)}> but found </${shortName(tag.name)}>`,
          );
        }
        if (open.length === 0) rootClosed = true;
        continue;
      }

      if (open.length === 0 && rootClosed) throw notWellFormed('more than one root element');
      elements += 1;
      if (elements > limits.maxElements) {
        throw new XmlRejectedError(`The XML has more than ${limits.maxElements} elements.`);
      }
      if (open.length + 1 > limits.maxDepth) {
        throw new XmlRejectedError(`The XML is nested deeper than ${limits.maxDepth} levels.`);
      }
      if (tag.selfClosing) {
        if (open.length === 0) rootClosed = true;
      } else {
        open.push(tag.name);
      }
    }
  }
  if (open.length > 0) throw notWellFormed(`<${shortName(open.at(-1) ?? '')}> is not closed`);
  if (!rootClosed) throw notWellFormed('no root element');
}

const predefinedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Entity processing is off in the parser. This decodes only the five predefined XML entities and
 * character references, which never expand into markup or other entities. Anything else stays as is.
 */
export function decodeXmlText(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(
    /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g,
    (match, decimal?: string, hex?: string, named?: string) => {
      if (named !== undefined) return predefinedEntities[named] ?? match;
      const codePoint = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? '', 16);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    },
  );
}

/** Tags that may repeat, so they always parse as arrays. */
const listTags = new Set([
  'name',
  'documentation',
  'value',
  'element',
  'relationship',
  'property',
  'propertyDefinition',
  'view',
  'item',
]);

/**
 * Parses untrusted XML safely: size, depth and element limits, a well-formedness check, no
 * DOCTYPE, and no DTD or entity processing. Namespace prefixes are removed (`xsi:type` → `@_type`,
 * `xml:lang` → `@_lang`). Throws XmlRejectedError with a user-safe message.
 */
export function parseXml(
  xml: string,
  limits: XmlLimits = defaultXmlLimits,
): Record<string, unknown> {
  if (Buffer.byteLength(xml, 'utf8') > limits.maxBytes) {
    throw new XmlRejectedError(`The XML is larger than ${limits.maxBytes} bytes.`);
  }
  checkEncoding(xml);
  checkXml(xml, limits);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: false,
    htmlEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    maxNestedTags: limits.maxDepth,
    isArray: (tagName) => listTags.has(tagName),
    tagValueProcessor: (_tagName, value) => decodeXmlText(value),
    attributeValueProcessor: (_name, value) => decodeXmlText(value),
  });
  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new XmlRejectedError('The XML could not be parsed.');
  }
}
