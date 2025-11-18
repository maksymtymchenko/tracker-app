#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const releaseType = process.argv[2]; // 'patch', 'minor', or 'major'

if (!releaseType || !['patch', 'minor', 'major'].includes(releaseType)) {
  console.error('Usage: npm run release:patch|minor|major');
  process.exit(1);
}

try {
  // Read current version
  const packagePath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const currentVersion = packageJson.version;
  
  console.log(`Current version: ${currentVersion}`);
  console.log(`Bumping ${releaseType} version...`);

  // Bump version (without creating git tag)
  execSync(`npm version ${releaseType} --no-git-tag-version`, { stdio: 'inherit' });

  // Read new version
  const newPackageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const newVersion = newPackageJson.version;

  console.log(`New version: ${newVersion}`);

  // Stage package files
  console.log('Staging package.json and package-lock.json...');
  execSync('git add package.json package-lock.json', { stdio: 'inherit' });

  // Commit
  console.log('Creating commit...');
  execSync(`git commit -m "Bump version to ${newVersion}"`, { stdio: 'inherit' });

  // Push to main
  console.log('Pushing to main branch...');
  execSync('git push origin main', { stdio: 'inherit' });

  // Create and push tag
  const tagName = `v${newVersion}`;
  console.log(`Creating tag ${tagName}...`);
  execSync(`git tag ${tagName}`, { stdio: 'inherit' });
  execSync(`git push origin ${tagName}`, { stdio: 'inherit' });

  console.log(`\n✅ Release ${newVersion} created and pushed!`);
  console.log(`📦 GitHub Actions will now build and upload to R2 bucket.`);
} catch (error) {
  console.error('❌ Release failed:', error.message);
  process.exit(1);
}

