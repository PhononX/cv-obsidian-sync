import { readFileSync, writeFileSync } from 'fs'

// Invoked by `npm version` via the "version" lifecycle script. It reads the new
// version chosen by npm (exposed as npm_package_version), then keeps
// manifest.json and versions.json in sync so the GitHub release tag, the plugin
// manifest, and the version→minAppVersion map never drift apart.
const targetVersion = process.env.npm_package_version
if (!targetVersion) {
  console.error('version-bump: npm_package_version is not set; run via `npm version`.')
  process.exit(1)
}

// Update manifest.json with the target version, keeping minAppVersion as-is.
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'))
const { minAppVersion } = manifest
manifest.version = targetVersion
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n')

// Record the new version → minAppVersion mapping so older Obsidian installs pull
// a compatible build.
const versions = JSON.parse(readFileSync('versions.json', 'utf8'))
versions[targetVersion] = minAppVersion
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n')
