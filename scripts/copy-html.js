const fs = require('fs');
const path = require('path');

const srcHtml = path.join(__dirname, '../src/renderer/index.html');
const destDir = path.join(__dirname, '../dist/renderer');
const destHtml = path.join(destDir, 'index.html');

// Ensure dest directory exists
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

// Copy HTML file
fs.copyFileSync(srcHtml, destHtml);
console.log('Copied index.html to dist/renderer/');

