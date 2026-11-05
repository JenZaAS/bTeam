import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, audienceValue } from '../src/markdown.js';
import { createViewer } from '../src/visibility.js';

function viewerWith(audiences) {
  return createViewer(
    {
      roles: {
        owner: {
          name: 'owner',
          hide: { paths: [], boxes: [], issueLabels: [], issueTitlePatterns: [] },
          policy: {},
          audiences,
        },
      },
    },
    'owner',
  );
}

const allowed = viewerWith(['all']);

test('CRLF front matter keeps audience all', () => {
  const { data, body } = splitFrontMatter('---\r\naudience: all\r\n---\r\n# Title\r\n');
  assert.equal(audienceValue(data), 'all');
  assert.equal(body, '# Title\r\n');
  assert.equal(allowed.canSeeAudience(audienceValue(data)), true);
});

test('a BOM before the opening marker leaves no audience', () => {
  const text = '\uFEFF---\naudience: all\n---\n# Title\n';
  const { data, body } = splitFrontMatter(text);
  assert.deepEqual(data, {});
  assert.equal(body, text);
  assert.equal(audienceValue(data), '');
  assert.equal(allowed.canSeeAudience(audienceValue(data)), false);
});

test('a quoted audience value is the string inside the quotes', () => {
  const { data } = splitFrontMatter('---\naudience: "all"\n---\n# Title\n');
  assert.equal(audienceValue(data), 'all');
  assert.equal(allowed.canSeeAudience(audienceValue(data)), true);
});

test('a wrong-case key and a wrong-case value are both left out', () => {
  const key = splitFrontMatter('---\nAudience: all\n---\n# Title\n');
  const value = splitFrontMatter('---\naudience: All\n---\n# Title\n');
  assert.equal(audienceValue(key.data), '');
  assert.equal(audienceValue(value.data), 'All');
  assert.equal(allowed.canSeeAudience(audienceValue(key.data)), false);
  assert.equal(allowed.canSeeAudience(audienceValue(value.data)), false);
});

test('duplicate audience keys leave no audience', () => {
  for (const text of ['---\naudience: all\naudience: nope\n---\n# Title\n', '---\naudience: nope\naudience: all\n---\n# Title\n']) {
    const { data } = splitFrontMatter(text);
    assert.deepEqual(data, {});
    assert.equal(audienceValue(data), '');
    assert.equal(allowed.canSeeAudience(audienceValue(data)), false);
  }
});

test('a role whose audiences value is not a list sees no Markdown', () => {
  const hide = { paths: [], boxes: [], issueLabels: [], issueTitlePatterns: [] };
  const policy = {};
  for (const audiences of [undefined, null, 'all', { all: true }]) {
    const role = { name: 'owner', hide, policy };
    if (audiences !== undefined) role.audiences = audiences;
    const viewer = createViewer({ roles: { owner: role } }, 'owner');
    assert.deepEqual(viewer.audiences, []);
    assert.equal(viewer.canSeeAudience('all'), false);
  }
  assert.equal(viewerWith([]).canSeeAudience('all'), false);
  assert.equal(viewerWith(['all']).canSeeAudience('all'), true);
});
