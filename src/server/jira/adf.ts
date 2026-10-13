// Atlassian Document Format (ADF), the JSON Jira Cloud keeps descriptions and comments in, to and
// from Markdown: the windows show Markdown, workers' prompts take it as text, and a comment typed in
// the office goes to Jira as the simplest ADF there is. A node this doesn't know comes out as its text.

/** An ADF node, as loosely as Jira sends it. */
export interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type?: string; attrs?: Record<string, any> }[];
  content?: AdfNode[];
}

/** Inline text with its marks: **bold**, _italic_, `code`, ~~struck~~ and [links](…). */
function marked(n: AdfNode): string {
  let t = n.text ?? '';
  if (!t) return '';
  const marks = n.marks ?? [];
  const has = (type: string) => marks.some((m) => m.type === type);
  if (has('code')) t = `\`${t.replace(/`/g, 'ˋ')}\``;
  else {
    if (has('strong')) t = `**${t}**`;
    if (has('em')) t = `_${t}_`;
    if (has('strike')) t = `~~${t}~~`;
  }
  const href = marks.find((m) => m.type === 'link')?.attrs?.href;
  return typeof href === 'string' && href ? `[${t}](${href})` : t;
}

/** A node that sits in a line of text. */
function inline(n: AdfNode): string {
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'text':
      return marked(n);
    case 'hardBreak':
      return '  \n';
    case 'mention':
      return String(a.text ?? '@someone').replace(/^(?!@)/, '@');
    case 'emoji':
      return String(a.text ?? a.shortName ?? '');
    case 'status':
      return a.text ? `[${String(a.text).toUpperCase()}]` : '';
    case 'date': {
      const ms = Number(a.timestamp);
      return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
    }
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return typeof a.url === 'string' ? `<${a.url}>` : '';
    case 'placeholder':
      return '';
    default:
      // Something newer than this: its text, whatever it's wrapped in.
      return n.text ?? (n.content ?? []).map(inline).join('');
  }
}

const inlines = (n: AdfNode) => (n.content ?? []).map(inline).join('');

/** Puts `prefix` before a block's first line and `rest` before the others (list items, quotes). */
function indent(text: string, prefix: string, rest = ' '.repeat(prefix.length)): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? prefix : l ? rest : '') + l)
    .join('\n');
}

/** A list's items, bullets or numbers, each item's own blocks under its marker. */
function list(n: AdfNode, ordered: boolean): string {
  const start = Number(n.attrs?.order) || 1;
  return (n.content ?? [])
    .map((item, i) => {
      const done = item.type === 'taskItem' || item.type === 'decisionItem' ? (item.attrs?.state === 'DONE' || item.attrs?.state === 'DECIDED' ? '[x] ' : '[ ] ') : '';
      // An item's own blocks (its text, a list inside it) go one under the other, so the list stays tight.
      const body = item.type === 'listItem' ? (item.content ?? []).map(block).filter((b) => b.trim()).join('\n') : inlines(item);
      return indent(`${done}${body}`, ordered ? `${start + i}. ` : '- ');
    })
    .join('\n');
}

function table(n: AdfNode): string {
  const rows = (n.content ?? []).map((row) => (row.content ?? []).map((cell) => blocks(cell.content).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** A block: a paragraph, a heading, a list, code, a quote… */
function block(n: AdfNode): string {
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'paragraph':
      return inlines(n);
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(a.level) || 1)))} ${inlines(n)}`;
    case 'bulletList':
    case 'taskList':
    case 'decisionList':
      return list(n, false);
    case 'orderedList':
      return list(n, true);
    case 'codeBlock': {
      const code = (n.content ?? []).map((c) => c.text ?? '').join('');
      const fence = code.includes('```') ? '~~~' : '```';
      return `${fence}${typeof a.language === 'string' ? a.language : ''}\n${code}\n${fence}`;
    }
    case 'blockquote':
      return indent(blocks(n.content), '> ', '> ');
    case 'panel': {
      const icon = { info: 'ℹ️', note: '📝', warning: '⚠️', error: '⛔', success: '✅', tip: '💡' }[String(a.panelType)] ?? 'ℹ️';
      return indent(`${icon} ${blocks(n.content)}`, '> ', '> ');
    }
    case 'expand':
    case 'nestedExpand':
      return [a.title ? `**${a.title}**` : '', blocks(n.content)].filter(Boolean).join('\n\n');
    case 'rule':
      return '---';
    case 'table':
      return table(n);
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '_(an attachment: open the ticket in Jira to see it)_';
    case 'layoutSection':
    case 'layoutColumn':
    case 'bodiedExtension':
      return blocks(n.content);
    case 'blockCard':
    case 'embedCard':
      return inline(n);
    default:
      // A block this doesn't know: its blocks if it has any, else its text.
      return n.content?.some((c) => c.type && c.type !== 'text' && !INLINE.has(c.type)) ? blocks(n.content) : inline(n);
  }
}

const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'status', 'date', 'inlineCard', 'placeholder']);

function blocks(content: AdfNode[] | undefined): string {
  return (content ?? [])
    .map(block)
    .filter((b) => b.trim())
    .join('\n\n');
}

/** A Jira document (a description, a comment) as Markdown. Plain text (Jira Server's) comes back as it is. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  if (!doc || typeof doc !== 'object') return '';
  const n = doc as AdfNode;
  return (n.type === 'doc' ? blocks(n.content) : block(n)).trim();
}

/** Plain text as a Jira document: a paragraph for each run of lines, its lines kept apart. */
export function textToAdf(text: string): AdfNode {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.split('\n'));
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((lines) => ({
      type: 'paragraph',
      content: lines.flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
    })),
  } as AdfNode;
}
