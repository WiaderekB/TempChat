import MarkdownIt from './vendor/markdown-it.mjs';

const markdown = new MarkdownIt({ html: false, breaks: true });
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url) => !/^data:/i.test(url.trim()) && validateLink(url);

markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const url = markdown.utils.escapeHtml(token.attrGet('src'));
  const label = renderer.renderInlineAsText(token.children, options, env) || 'Open image';
  return '<a href="' + url + '">' + markdown.utils.escapeHtml(label) + '</a>';
};

markdown.renderer.rules.table_open = () => '<div class="markdown-table"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';
const tableAlignments = { 'text-align:left': 'left', 'text-align:center': 'center', 'text-align:right': 'right' };

function tableCell(tokens, index) {
  const token = tokens[index];
  const align = tableAlignments[token.attrGet('style')];
  return '<' + token.tag + (align ? ' class="align-' + align + '"' : '') + '>';
}

markdown.renderer.rules.th_open = tableCell;
markdown.renderer.rules.td_open = tableCell;

export function markdownHtml(source) {
  return markdown.render(source);
}
