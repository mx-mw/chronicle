import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFrontmatter, renderMarkdown } from './markdown.js';

test('web frontmatter decodes quoted YAML scalars', () => {
  const parsed = parseFrontmatter(
    '---\r\nname: "record:alpha"\r\ndescription: \'Ethan\'\'s meeting\'\r\ntype: "meeting"\r\n---\r\n# Alpha\r\n',
  );

  assert.deepEqual(parsed.meta, {
    name: 'record:alpha',
    description: "Ethan's meeting",
    type: 'meeting',
  });
  assert.equal(parsed.body, '# Alpha\r\n');
});

test('generated blockquotes render as quotes and Chronicle fact markers stay internal', () => {
  const html = renderMarkdown(`---
type: "meeting"
---
# Project update

## Source highlights
> Max: Review the **prototype**.
>
> Ethan: I will send it. [[transcripts/source-1]]

## Facts
- Chronicle stores approved facts. <!-- chronicle-fact:abc123 -->
`);

  assert.match(
    html,
    /<blockquote><p>Max: Review the <strong>prototype<\/strong>\.<\/p>\n<p>Ethan: I will send it\./,
  );
  assert.match(html, /data-note="transcripts\/source-1\.md"/);
  assert.match(html, /<li>Chronicle stores approved facts\.<\/li>/);
  assert.doesNotMatch(html, /chronicle-fact|&lt;!--|&gt; Max|<p>&gt;/);
});
