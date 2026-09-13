/** Build headings and search text from the same MDX AST that renders the page. */
export default function remarkHelpIndex() {
  return (tree) => {
    const sections = [];
    const ids = new Set();
    let pendingId;
    let section;
    const plain = node => node.type === 'yaml' || node.type === 'mdxjsEsm' ? ''
      : typeof node.value === 'string' ? node.value
      : [
          ...(['StateCard', 'StateDetail', 'FlowStep'].includes(node.name)
            ? (node.attributes ?? []).filter(attribute => ['title', 'code', 'label'].includes(attribute.name) && typeof attribute.value === 'string').map(attribute => attribute.value)
            : []),
          ...(node.children ?? []).map(plain),
        ].join(' ');
    tree.children = tree.children.filter(node => {
      if (node.type === 'mdxJsxFlowElement' && node.name === 'a') {
        const id = node.attributes.find(attribute => attribute.name === 'id')?.value;
        if (typeof id === 'string' && !node.attributes.some(attribute => attribute.name === 'href')) {
          pendingId = id;
          return false;
        }
      }
      if (node.type === 'heading') {
        const title = plain(node);
        const id = pendingId ?? title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
        pendingId = undefined;
        if (!id || ids.has(id)) throw new Error(`Help heading requires a unique ID: ${title}`);
        ids.add(id);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
        section = { id, title, text: title };
        sections.push(section);
      } else if (section) section.text += ` ${plain(node)}`;
      return true;
    });
    const searchText = tree.children.map(plain).join(' ');
    const exports = { sections, searchText };
    tree.children.push({ type: 'mdxjsEsm', value: '', data: { estree: {
      type: 'Program', sourceType: 'module', body: Object.entries(exports).map(([name, value]) => ({
        type: 'ExportNamedDeclaration', specifiers: [], source: null,
        declaration: { type: 'VariableDeclaration', kind: 'const', declarations: [{
          type: 'VariableDeclarator', id: { type: 'Identifier', name },
          init: { type: 'CallExpression', optional: false,
            callee: { type: 'MemberExpression', object: { type: 'Identifier', name: 'JSON' }, property: { type: 'Identifier', name: 'parse' }, computed: false, optional: false },
            arguments: [{ type: 'Literal', value: JSON.stringify(value) }] },
        }] },
      })),
    } } });
  };
}
