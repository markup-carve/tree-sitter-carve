// The comparison behind `inline-reading.mjs`, importable so its cases can be
// tested without the corpus (tests/inline-reading.test.mjs).

// One occurrence of the node renders as this tag. `tag` and `mention` render
// their own text in bold. `bold_italic` and `substitution` are handled below,
// because each renders as two containers.
const NODE_TAG = {
  strong: 'strong',
  emphasis: 'em',
  underline: 'u',
  strikethrough: 's',
  highlighted: 'mark',
  insert: 'ins',
  delete: 'del',
  verbatim: 'code',
  tag: 'strong',
  mention: 'strong',
};
export const TAGS = ['strong', 'em', 'u', 's', 'mark', 'ins', 'del', 'code'];

const REFERENCES = new Set([
  'collapsed_reference_link',
  'full_reference_link',
  'collapsed_reference_image',
  'full_reference_image',
]);
const IMAGES = new Set(['inline_image', 'collapsed_reference_image', 'full_reference_image']);

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
const skeleton = (s) =>
  decode(s).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

// The spec's lookup key for a reference label (scripts/spec/label-key.mjs).
const labelKey = (s) => s.replace(/[ \t\n\f\r]+/g, ' ').replace(/^ | $/g, '');

// Source a reader never sees inside a non-code span: comments, link
// destinations, a reference link's label and attribute blocks. Inside a code
// span every one of those is literal text, so code spans keep them.
const visible = (s) =>
  s
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/\{#[\s\S]*?#\}/g, '')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/\]\[[^\]]*\]/g, ']')
    .replace(/\{[.#:][^}]*\}/g, '')
    .replace(/\{[A-Za-z_][\w-]*=[^}]*\}/g, '');

export function htmlSpans(html) {
  // A fenced code block renders <pre><code>, with no `verbatim` node behind it.
  const s = html.replace(/<pre[\s\S]*?<\/pre>/g, '');
  const out = [];
  const stack = [];
  const text = [];
  const re = /<(\/?)([a-z0-9]+)([^>]*)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    text.push(s.slice(last, m.index));
    last = re.lastIndex;
    const [, close, tag, rest] = m;
    if (!TAGS.includes(tag) || rest.endsWith('/')) continue;
    const at = text.join('').length;
    if (close) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === tag) {
          const open = stack.splice(k, 1)[0];
          out[open.index].text = text.join('').slice(open.at, at);
          break;
        }
      }
    } else {
      out.push({ tag, text: '' });
      stack.push({ tag, at, index: out.length - 1 });
    }
  }
  return out;
}

/** Every `alt` attribute, in document order. */
export function htmlAlts(html) {
  return [...html.replace(/<pre[\s\S]*?<\/pre>/g, '').matchAll(/<img\b[^>]*\balt="([^"]*)"/g)].map(
    (m) => decode(m[1]),
  );
}

/** Every node in the tree with its byte range, in document order. */
function treeNodes(tree, source) {
  // Tree positions are BYTE columns, so slice a Buffer rather than a string.
  const buf = Buffer.from(source, 'utf8');
  const lineStart = [0];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a || (buf[i] === 0x0d && buf[i + 1] !== 0x0a)) lineStart.push(i + 1);
  }
  const at = (row, col) => (lineStart[row] ?? buf.length) + col;
  const nodes = [];
  const re = /(?:([a-z_]+): )?\(([a-z_]+) \[(\d+), (\d+)\] - \[(\d+), (\d+)\]/g;
  for (const [, field, node, r1, c1, r2, c2] of tree.matchAll(re)) {
    const start = at(+r1, +c1);
    const end = at(+r2, +c2);
    nodes.push({ field, node, start, end, text: buf.slice(start, end).toString('utf8') });
  }
  return nodes;
}

const inside = (n, range) => n.start >= range.start && n.end <= range.end;

/**
 * Ranges whose inline spans the HTML cannot show: image descriptions, which
 * render flat into `alt`, and reference links or images that do not resolve,
 * which render as the source the author typed. Whether a reference resolves is
 * a question about the definition table and the headings, not the parse, so it
 * is read from the fixture: unresolved means the HTML shows the reference's own
 * source (#320).
 */
function hiddenRanges(nodes, html) {
  const shown = labelKey(decode(html.replace(/<[^>]*>/g, '')));
  const hidden = [];
  const unresolvedImages = [];
  for (const ref of nodes.filter((n) => REFERENCES.has(n.node))) {
    if (shown.includes(labelKey(ref.text))) {
      hidden.push(ref);
      if (IMAGES.has(ref.node)) unresolvedImages.push(ref);
    }
  }
  for (const n of nodes) if (n.node === 'image_description') hidden.push(n);
  return { hidden, unresolvedImages };
}

export function treeSpans(tree, source, html) {
  const nodes = treeNodes(tree, source);
  const { hidden } = hiddenRanges(nodes, html);
  const out = [];
  for (const n of nodes) {
    if (hidden.some((h) => h !== n && inside(n, h))) continue;
    // A substitution renders two SIBLING containers, one per half. An empty
    // half has no field in the tree, so both slots are reserved up front.
    if (n.node === 'substitution') {
      out.push({ tag: 'del', text: '', half: true }, { tag: 'ins', text: '', half: true });
      continue;
    }
    if (n.node === 'content' && (n.field === 'from' || n.field === 'to')) {
      const tag = n.field === 'from' ? 'del' : 'ins';
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].half && out[k].tag === tag) {
          out[k].text = n.text;
          delete out[k].half;
          break;
        }
      }
      continue;
    }
    if (n.node === 'bold_italic') {
      out.push({ tag: 'strong', text: n.text }, { tag: 'em', text: n.text });
      continue;
    }
    const tag = NODE_TAG[n.node];
    if (tag) out.push({ tag, text: n.text });
  }
  return out;
}

/** The text of every image description that renders as an `alt`. */
export function treeAlts(tree, source, html) {
  const nodes = treeNodes(tree, source);
  const { unresolvedImages } = hiddenRanges(nodes, html);
  return nodes
    .filter(
      (n) => n.node === 'image_description' && !unresolvedImages.some((u) => inside(n, u)),
    )
    .map((n) => n.text);
}

export function reading(html, tree, source) {
  const want = htmlSpans(html);
  const got = treeSpans(tree, source, html);
  const problems = [];
  for (const tag of TAGS) {
    const w = want.filter((x) => x.tag === tag);
    const g = got.filter((x) => x.tag === tag);
    if (w.length !== g.length) problems.push(`${tag} html=${w.length} tree=${g.length}`);
    for (let k = 0; k < Math.min(w.length, g.length); k++) {
      const a = skeleton(w[k].text);
      const b = skeleton(tag === 'code' ? g[k].text : visible(g[k].text));
      if (a !== b) problems.push(`${tag}#${k + 1} html="${a}" tree="${b}"`);
    }
  }
  // Alt text renders flat, so it is compared as text rather than as spans.
  const wa = htmlAlts(html);
  const ga = treeAlts(tree, source, html);
  if (wa.length !== ga.length) problems.push(`alt html=${wa.length} tree=${ga.length}`);
  for (let k = 0; k < Math.min(wa.length, ga.length); k++) {
    const a = skeleton(wa[k]);
    const b = skeleton(ga[k]);
    if (a !== b) problems.push(`alt#${k + 1} html="${a}" tree="${b}"`);
  }
  return problems.join(', ');
}
