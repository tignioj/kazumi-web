import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCommentEpisode } from '../../src/lib/episode-comments.js';

const episodes = [
  { id: 1002, sort: 2, type: 0 },
  { id: 1001, sort: 1, type: 0 },
  { id: 1003, sort: 1, type: 1 },
  { id: 1004, sort: 1.5, type: 0 },
];

test('episode matching uses explicit numbers instead of source playlist positions', () => {
  for (const name of ['第1集', '第 1 话', 'EP01', 'Episode 1', '01', '０１', '第1集 标题'])
    assert.equal(matchCommentEpisode(episodes, name), '1001', name);
  assert.equal(matchCommentEpisode(episodes, '第2集'), '1002');
  assert.equal(matchCommentEpisode(episodes, '第1.5话'), '1004');
});

test('specials, ranges, ambiguous numbering and unnumbered titles require manual selection', () => {
  for (const name of [
    'SP1',
    'OVA 1',
    '特别篇',
    '预告 1',
    '第1-2集',
    '1 - 2',
    '第1集 第2集',
    '第1集~第2集',
    '全12集',
    '第一话',
    '正片',
    '第9集',
    '第1集合集',
  ])
    assert.equal(matchCommentEpisode(episodes, name), '', name);
  assert.equal(matchCommentEpisode([...episodes, { id: 2001, sort: 1, type: 0 }], '第1集'), '');
});
