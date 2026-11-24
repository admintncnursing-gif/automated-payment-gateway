const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'public');
const outputDir = path.join(rootDir, 'dist');

if (!fs.existsSync(sourceDir)) {
  throw new Error('Cloudflare build failed: public directory not found');
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.cpSync(sourceDir, outputDir, { recursive: true });

console.log(`Cloudflare Pages assets prepared in ${path.relative(rootDir, outputDir)}`);
