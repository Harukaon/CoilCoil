#!/usr/bin/env node
/* Parse source as data. Never import or evaluate the extracted bundle. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

const [sourcePath, ...symbols] = process.argv.slice(2);
if (!sourcePath || symbols.length === 0) {
  console.error('Usage: node inspect_symbols.cjs RAW_FILE SYMBOL [SYMBOL ...]');
  process.exit(2);
}
const source = fs.readFileSync(sourcePath, 'utf8');
const start = Number(path.basename(sourcePath, '.js'));
if (!Number.isSafeInteger(start)) throw new Error('Expected an offset-named raw file');
const manifestPath = path.join(path.dirname(sourcePath), '..', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const record = manifest.sources.find(entry => entry.file === path.basename(sourcePath));
const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
if (!record || record.offset !== start || record.length !== Buffer.byteLength(source, 'utf8')
    || record.sha256 !== sourceHash) {
  throw new Error('Raw source does not match its extraction manifest');
}
const ast = parser.parse(source, { sourceType: 'module' });
const found = new Set();
for (let statement of ast.program.body) {
  if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
    statement = statement.declaration;
  }
  const nodes = statement.type === 'VariableDeclaration'
    ? statement.declarations
    : [statement];
  for (const node of nodes) {
    const name = node.id?.name;
    if (!symbols.includes(name)) continue;
    const exact = source.slice(node.start, node.end);
    const offset = start + Buffer.byteLength(source.slice(0, node.start), 'utf8');
    found.add(name);
    console.log(`\n## ${name}\n`);
    console.log(`- raw: ${path.basename(sourcePath)}`);
    console.log(`- absolute binary byte offset: ${offset}`);
    console.log(`- exact source bytes: ${Buffer.byteLength(exact, 'utf8')}`);
    console.log(`- exact source SHA-256: ${crypto.createHash('sha256').update(exact).digest('hex')}\n`);
    console.log('```javascript');
    console.log(generate(node, { comments: false }).code);
    console.log('```');
  }
}
const missing = symbols.filter(name => !found.has(name));
if (missing.length) {
  console.error(`Not found at module top level: ${missing.join(', ')}`);
  process.exitCode = 1;
}
