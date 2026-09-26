const fs = require('fs');
const path = require('path');

const files = [
  'main.js',
  'renderer/app.js',
  'renderer/preload.js',
];

for (const f of files) {
  const fp = path.join(__dirname, f);
  const src = fs.readFileSync(fp, 'utf8');
  try {
    new Function(src);
    console.log(f + ': SYNTAX OK');
  } catch (e) {
    console.log(f + ': SYNTAX ERROR - ' + e.message + ' at line ' + e.lineNumber + ', col ' + e.columnNumber);
  }
}

// Find duplicate const declarations in main.js
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const mainLines = mainSrc.split('\n');
const decls = {};
mainLines.forEach((line, i) => {
  const m = line.match(/^\s*(const|let|var)\s+(\w+)/);
  if (m) {
    const key = m[1] + ' ' + m[2];
    if (!decls[key]) decls[key] = [];
    decls[key].push(i + 1);
  }
});
console.log('\n=== Duplicate declarations in main.js ===');
for (const [k, v] of Object.entries(decls)) {
  if (v.length > 1) {
    console.log(k + ' at lines: ' + v.join(', '));
  }
}
