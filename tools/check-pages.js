'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(PUB).filter(f => f.endsWith('.html'));
let failures = 0;

for (const f of pages) {
  const html = fs.readFileSync(path.join(PUB, f), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)];
  scripts.forEach((m, i) => {
    const body = m[1];
    if (!body.trim()) return;
    const tmp = path.join(__dirname, '.tmp-check.js');
    fs.writeFileSync(tmp, body);
    try {
      require('child_process').execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      console.log('OK   ' + f + ' [script ' + i + ']');
    } catch (e) {
      failures++;
      console.log('FAIL ' + f + ' [script ' + i + ']\n' + e.stderr.toString());
    } finally {
      fs.unlinkSync(tmp);
    }
  });
}
process.exit(failures ? 1 : 0);
