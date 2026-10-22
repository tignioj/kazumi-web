import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXPathSearch, parseXPathChapters } from '../../server/modules/rules/engine.js';

const rule = {
  baseURL: 'https://example.com',
  searchList: '//article',
  searchName: '//a | //b/a',
  searchResult: '//a | //b/a',
  chapterRoads: '//ul',
  chapterResult: '//a | //li/a',
};
const searchHtml =
  '<article><b><a href="/one">One</a></b></article>' +
  '<article><b><a href="/two">Two</a></b></article>';
const searchItems = [
  { name: 'One', url: 'https://example.com/one' },
  { name: 'Two', url: 'https://example.com/two' },
];

test('XPath union branches stay within each search result', () => {
  assert.deepEqual(parseXPathSearch(searchHtml, rule), searchItems);
});

test('XPath union branch priority determines the first title and link within each fragment', () => {
  const html =
    '<article><b href="/fallback">Fallback</b><a href="/preferred">Preferred</a></article>';
  assert.deepEqual(
    parseXPathSearch(html, { ...rule, searchName: '//a | //b', searchResult: '//a | //b' }),
    [{ name: 'Preferred', url: 'https://example.com/preferred' }],
  );
});

test('XPath union branches stay within each chapter road without duplicate episodes', () => {
  const html =
    '<ul><li><a href="/one">One</a><a href="/two">Two</a></li></ul>' +
    '<ul><li><a href="/three">Three</a></li></ul>';
  assert.deepEqual(parseXPathChapters(html, rule), [
    {
      name: '播放线路1',
      episodes: [
        { name: 'One', url: 'https://example.com/one' },
        { name: 'Two', url: 'https://example.com/two' },
      ],
    },
    {
      name: '播放线路2',
      episodes: [{ name: 'Three', url: 'https://example.com/three' }],
    },
  ]);
});

test('XPath grouped and nested union branches retain their fragment scope', () => {
  for (const selector of [' ( //a | //b/a )[1] ', '(//a | (//b/a))[1]']) {
    assert.deepEqual(
      parseXPathSearch(searchHtml, { ...rule, searchName: selector, searchResult: selector }),
      searchItems,
    );
  }
});

test('XPath unions inside predicates and groups remain part of their enclosing expression', () => {
  const html =
    '<article><b href="/one">One</b><a href="/preferred">Preferred</a></article>' +
    '<article><b href="/two">Two</b></article>';
  assert.deepEqual(
    parseXPathSearch(html, {
      ...rule,
      searchList: '//article[a | b]',
      searchName: '(//a | //b)[1]',
      searchResult: '(//a | //b)[1]',
    }),
    searchItems,
  );
});

test('XPath child paths and descendant continuations retain their fragment scope', () => {
  assert.deepEqual(
    parseXPathSearch(searchHtml, {
      ...rule,
      searchName: '/b//a | /b/a',
      searchResult: '/b//a | /b/a',
    }),
    searchItems,
  );
});

test('XPath predicates preserve quoted pipes, slashes and parentheses in either quote style', () => {
  const html =
    '<article><b><a data-mark="a|//b(/x)" href="/one">One</a></b></article>' +
    '<article><b><a data-mark="a|//b(/x)" href="/two">Two</a></b></article>';
  for (const quote of ["'", '"']) {
    const selector = `//a[@data-mark=${quote}a|//b(/x)${quote}] | //missing`;
    assert.deepEqual(
      parseXPathSearch(html, { ...rule, searchName: selector, searchResult: selector }),
      searchItems,
    );
  }
});

test('XPath functions and operator-named elements preserve path boundaries', () => {
  const html =
    '<article><div><a href="/one">One</a></div><b><a href="/one">One</a></b></article>' +
    '<article><div><a href="/two">Two</a></div><b><a href="/two">Two</a></b></article>';
  assert.deepEqual(
    parseXPathSearch(html, {
      ...rule,
      searchName: 'string((//div/a | //b/a)[1])',
      searchResult: '//div/a[contains(@href, "/") and @href != "//"] | //b/a',
    }),
    searchItems,
  );
});

test('document-level unions append interleaved results and roads in branch order and deduplicate', () => {
  const html =
    '<article><a href="/one">One</a></article>' +
    '<section><a href="/two">Two</a></section>' +
    '<article><a href="/three">Three</a></article>';
  const items = [
    searchItems[0],
    { name: 'Three', url: 'https://example.com/three' },
    searchItems[1],
  ];
  assert.deepEqual(
    parseXPathSearch(html, {
      ...rule,
      searchList: '//article | //section | //article',
      searchName: '//a',
      searchResult: '//a',
    }),
    items,
  );
  assert.deepEqual(
    parseXPathChapters(html, {
      ...rule,
      chapterRoads: '//article | //section | //article',
      chapterResult: '//a',
    }),
    items.map((episode, index) => ({ name: `播放线路${index + 1}`, episodes: [episode] })),
  );
});

test('XPath unions deduplicate attribute selections by their owning element like Kazumi', () => {
  const html = '<ul><a href="/one" title="Alternative">One</a></ul>';
  for (const selector of [
    '//a/@href | //a',
    '//a | //a/@href',
    '//a/@href | //a/@title',
    '//a/@href | //a/@href',
  ]) {
    assert.deepEqual(parseXPathChapters(html, { ...rule, chapterResult: selector }), [
      { name: '播放线路1', episodes: [searchItems[0]] },
    ]);
  }
});

test('XPath union branches still require node results', () => {
  for (const selector of ['string(//a) | //b', '//a |', '| //a']) {
    assert.throws(
      () => parseXPathSearch(searchHtml, { ...rule, searchName: selector }),
      /XPath 无效/,
    );
  }
});
