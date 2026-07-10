// Server-side markdown → HTML for the KB's own dialect. Escapes all text before
// emitting any tag, so untrusted note content (speech transcripts, scraped web
// text) can never inject markup; wiki-links and citations become data-note
// anchors the client resolves against /api/notes.

export interface Frontmatter {
  name?: string;
  description?: string;
  type?: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export function parseFrontmatter(content: string): { meta: Frontmatter; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { meta: {}, body: content };
  const block = match[1];
  const get = (key: string) =>
    block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  return {
    meta: { name: get('name'), description: get('description'), type: get('type') },
    body: content.slice(match[0].length),
  };
}

/** The only place text crosses into HTML. Everything below runs on escaped strings. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A wiki target ("topics/storage") or citation names a note file; normalise to a
// kb-relative .md path the client can request. Reject anything with traversal or
// a leading slash so a crafted note body can't point the client outside kb/.
function noteHref(rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(target)) return null;
  if (target.includes('..') || target.startsWith('/')) return null;
  return target.endsWith('.md') ? target : `${target}.md`;
}

// Inline pass over ALREADY-ESCAPED text. The special characters these patterns
// key on (* [ ] ( ) ` |) are untouched by escapeHtml, so the patterns still see
// them, while any captured text stays escaped. Anchor attributes are built from
// validated targets only.
function renderInline(escaped: string): string {
  // Split on `code` spans first and transform ONLY the segments outside them.
  // Doing bold/wiki/citation passes over the whole string would reach inside an
  // emitted <code>…</code> and turn `[[topics/foo]]` (written literally to
  // document the syntax) into a live link nested in the code element.
  const parts = escaped.split(/(`[^`]+`)/);
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        return `<code>${part.slice(1, -1)}</code>`;
      }
      return renderInlineNonCode(part);
    })
    .join('');
}

/** Inline transforms for a segment already known to contain no code span. */
function renderInlineNonCode(escaped: string): string {
  let out = escaped;

  // [[target]] or [[target|label]]
  out = out.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (whole, target, label) => {
    const href = noteHref(target);
    if (!href) return whole;
    const text = (label ?? target).trim();
    return `<a class="wikilink" href="#/note/${href}" data-note="${href}">${text}</a>`;
  });

  // [text](url) — only http(s) or in-app anchors survive; other schemes render as text.
  out = out.replace(/\[([^\]]+?)\]\(([^)\s]+?)\)/g, (whole, text, url) => {
    if (/^https?:\/\//i.test(url) || url.startsWith('#') || url.startsWith('/')) {
      return `<a href="${url}" rel="noopener noreferrer">${text}</a>`;
    }
    return whole;
  });

  // Recall citations like [topics/storage] — always contain a slash, which is
  // how we tell them apart from stray bracketed prose and checkbox markers.
  out = out.replace(/\[([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)+)\]/gi, (whole, target) => {
    const href = noteHref(target);
    if (!href) return whole;
    return `<a class="citation" href="#/note/${href}" data-note="${href}">${target}</a>`;
  });

  // **bold**
  out = out.replace(/\*\*([^*]+?)\*\*/g, (_m, inner) => `<strong>${inner}</strong>`);

  return out;
}

/** Render the KB subset: h1-h3, bullet lists (incl. task checkboxes), bold, inline code, links, wiki-links, fenced code. */
export function renderMarkdown(markdown: string): string {
  const { body } = parseFrontmatter(markdown);
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];

  let i = 0;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(escapeHtml(paragraph.join(' ')))}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*-\s+/, '');
        const task = item.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          const checked = task[1].toLowerCase() === 'x';
          const box = `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
          items.push(`<li class="task">${box}${renderInline(escapeHtml(task[2]))}</li>`);
        } else {
          items.push(`<li>${renderInline(escapeHtml(item))}</li>`);
        }
        i += 1;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();

  return html.join('\n');
}
