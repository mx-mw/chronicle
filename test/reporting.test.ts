import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ageInDays,
  jaccard,
  localDate,
  normalizeFact,
  parseSimpleFrontmatter,
  sectionItems,
  tokenize,
} from '../src/reporting.js';

test('parses JSON-quoted frontmatter and preserves body', () => {
  const parsed = parseSimpleFrontmatter(
    '---\ntitle: "A title: with punctuation"\nworkspace_id: "team"\n---\n# Body\n',
  );
  assert.equal(parsed.frontmatter.title, 'A title: with punctuation');
  assert.equal(parsed.frontmatter.workspace_id, 'team');
  assert.equal(parsed.body, '# Body\n');
});

test('extracts bullet and task items from a section', () => {
  const body = '# Record\n\n## Action items\n- [ ] **Ethan**: Test the bot\n- Max: Review it\n\n## Notes\n- Later\n';
  assert.deepEqual(sectionItems(body, 'Action items'), [
    '**Ethan**: Test the bot',
    'Max: Review it',
  ]);
});

test('normalizes sourced fact tails for duplicate checks', () => {
  assert.equal(
    normalizeFact('The index is rebuildable. [[records/example]] (2026-07-10)'),
    'the index is rebuildable',
  );
});

test('computes topic token overlap', () => {
  assert.equal(jaccard(tokenize('Recording consent policy'), tokenize('Consent policy for recording')), 0.75);
  assert.equal(jaccard(tokenize('Audio pipeline'), tokenize('Web typography')), 0);
});

test('uses the configured absolute timezone date', () => {
  const instant = new Date('2026-07-09T18:00:00Z');
  assert.equal(localDate(instant, 'Asia/Hong_Kong'), '2026-07-10');
  assert.equal(ageInDays('2026-07-09', new Date('2026-07-10T00:00:00Z')), 1);
});
