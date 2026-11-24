import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownHtml } from '../web/markdown.mjs';

test('chat Markdown renders headings, lists, emphasis, and fenced code', () => {
  const html = markdownHtml('# Heading\n\n- **first**\n- second\n\n~~~js\nconst x = 1;\n~~~');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<ul>\s*<li><strong>first<\/strong><\/li>\s*<li>second<\/li>/);
  assert.match(html, /<pre><code class="language-js">const x = 1;/);
  assert.match(markdownHtml('#tag\n-flag'), /<p>#tag<br>\s*-flag<\/p>/);
});

test('links and tables render without enabling HTML or embedded images', () => {
  const html = markdownHtml([
    '[website](https://example.com)',
    '![image](https://example.com/photo.png)',
    '<img src="photo.png">',
    '[invalid](javascript:alert%281%29)',
    '| Item | Count |\n|---|---:|\n| File | 1 |',
  ].join('\n\n'));
  assert.match(html, /<a href="https:\/\/example\.com">website<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com\/photo\.png">image<\/a>/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|href="javascript:|style="/);
  assert.match(html, /<td class="align-right">1<\/td>/);
});
