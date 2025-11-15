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

// Copy assets folder
const srcAssets = path.join(__dirname, '../src/assets');
const destAssets = path.join(__dirname, '../dist/assets');

if (fs.existsSync(srcAssets)) {
  // Ensure dest assets directory exists
  if (!fs.existsSync(destAssets)) {
    fs.mkdirSync(destAssets, { recursive: true });
  }

  // Copy all files from src/assets to dist/assets
  const files = fs.readdirSync(srcAssets);
  files.forEach((file) => {
    const srcFile = path.join(srcAssets, file);
    const destFile = path.join(destAssets, file);
    if (fs.statSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, destFile);
    }
  });
  console.log('Copied assets to dist/assets/');
}

