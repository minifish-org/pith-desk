// Publish only the small feed pointer after the immutable release is uploaded.
// The updates branch is metadata; source branches and release tags are untouched.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compareReleaseVersions } from './update-release.ts';

const repository = 'minifish-org/pith-desk';
const manifests = ['darwin-arm64', 'linux-amd64'].map(target => {
  const path = `preview/update-${target}.json`;
  const content = readFileSync(`build/releases/update-${target}.json`, 'utf8');
  const manifest = JSON.parse(content);
  if (process.env.RELEASE_TAG !== `v${manifest.version}`) throw new Error('Feed version must match the published release tag.');
  return {path, content, manifest};
});

function api(path: string, method = 'GET', body?: unknown, optional = false): any {
  const result = spawnSync('gh', ['api', `repos/${repository}/${path}`, '--method', method, ...(body ? ['--input', '-'] : [])], {
    input: body ? JSON.stringify(body) : undefined, encoding: 'utf8',
  });
  if (result.status !== 0) {
    if (optional && result.stderr.includes('HTTP 404')) return null;
    throw new Error(result.stderr || 'GitHub API request failed');
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

// Verify the shared installation/update archive exists before exposing the feed.
const release = api(`releases/tags/${process.env.RELEASE_TAG}`);
if (release.draft || manifests.some(({manifest}) => !release.assets.some((asset: any) => asset.browser_download_url === manifest.url))) {
  throw new Error('Publish the release and update archive before the update feed.');
}
const ref = api('git/ref/heads/updates', 'GET', undefined, true);
let baseTree: string | undefined;
const entries = [];
if (ref) {
  baseTree = api(`git/commits/${ref.object.sha}`).tree.sha;
}
for (const {path, content, manifest} of manifests) {
  if (ref) {
    const current = api(`contents/${path}?ref=updates`, 'GET', undefined, true);
    if (current) {
      const previous = JSON.parse(Buffer.from(current.content, 'base64').toString('utf8'));
      if (compareReleaseVersions(manifest.version, previous.version) <= 0) continue;
    }
  }
  entries.push({path, mode: '100644', type: 'blob', content});
}
if (!entries.length) {
  console.log('Update feeds already have this version or a newer one.'); process.exit(0);
}
const tree = api('git/trees', 'POST', {
  ...(baseTree ? { base_tree: baseTree } : {}),
  tree: entries,
});
const commit = api('git/commits', 'POST', {
  message: `Publish update feeds for ${process.env.RELEASE_TAG}`, tree: tree.sha,
  parents: ref ? [ref.object.sha] : [],
});
if (ref) api('git/refs/heads/updates', 'PATCH', { sha: commit.sha, force: false });
else api('git/refs', 'POST', { ref: 'refs/heads/updates', sha: commit.sha });
console.log(`Published update feeds for ${process.env.RELEASE_TAG}.`);
