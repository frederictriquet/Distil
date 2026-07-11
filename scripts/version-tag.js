#!/usr/bin/env node
// Create the annotated git tag matching package.json's version (roadmap 13.5).
//
// Release convention: bump `version` in package.json (SemVer), commit, then run
// `npm run version:tag` to create the annotated tag `v<version>`. This script
// deliberately does NOT push anything — pushing the tag is a separate, explicit
// step (`git push origin v<version>`).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version;
const tag = `v${version}`;

try {
	execFileSync('git', ['tag', '-a', tag, '-m', tag], { cwd: projectRoot, stdio: 'inherit' });
	console.log(`Created annotated tag ${tag}. Push it with: git push origin ${tag}`);
} catch {
	// git prints the real cause (e.g. tag already exists, not a repository, no
	// commits yet) to stderr above via stdio: 'inherit'; keep this message generic.
	console.error(`Failed to create tag ${tag}. See the git error above.`);
	process.exit(1);
}
