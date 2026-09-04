import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n?/gu, '\n');
const manifest = JSON.parse(read('package.json')) as Record<string, unknown>;

describe('Marketplace and GitHub readiness', () => {
  it('declares stable public identity and discovery metadata', () => {
    expect(manifest).toMatchObject({
      name: 'turnstage',
      displayName: 'TurnStage',
      publisher: 'turnstage',
      preview: true,
      pricing: 'Free',
      icon: 'media/icon.png',
      repository: { type: 'git', url: 'https://github.com/boloagegit/TurnStage.git' },
      homepage: 'https://github.com/boloagegit/TurnStage#readme',
      bugs: { url: 'https://github.com/boloagegit/TurnStage/issues' },
      galleryBanner: { color: '#101a2d', theme: 'dark' },
    });
    expect(manifest.enabledApiProposals).toBeUndefined();
    expect(manifest.extensionDependencies).toBeUndefined();
    expect(manifest.keywords).toEqual(expect.arrayContaining(['llm testing', 'red team', 'github copilot']));
    expect(manifest.keywords as unknown[]).toHaveLength(15);
  });

  it('ships a Retina-ready PNG icon and committed mock-data screenshots', () => {
    const icon = PNG.sync.read(readFileSync(resolve(root, 'media/icon.png')));
    expect(icon.width).toBeGreaterThanOrEqual(256);
    expect(icon.height).toBeGreaterThanOrEqual(256);

    for (const path of [
      'media/marketplace/stream-debug.png',
      'media/marketplace/automated-tests.png',
      'media/marketplace/red-team-evidence.png',
    ]) expect(existsSync(resolve(root, path)), `${path} must exist`).toBe(true);
  });

  it('keeps every relative README image resolvable from the repository', () => {
    const imageTargets = [...read('README.md').matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)]
      .map((match) => match[1]!)
      .filter((target) => !/^https?:/iu.test(target));
    expect(imageTargets.length).toBeGreaterThanOrEqual(3);
    for (const target of imageTargets) expect(existsSync(resolve(root, target)), target).toBe(true);
  });

  it('provides public privacy, security, support, contribution, and license notices', () => {
    for (const path of [
      'PRIVACY.md',
      'SECURITY.md',
      'SUPPORT.md',
      'CONTRIBUTING.md',
      'CODE_OF_CONDUCT.md',
      'THIRD_PARTY_NOTICES.md',
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/dependabot.yml',
    ]) expect(existsSync(resolve(root, path)), `${path} must exist`).toBe(true);

    const notices = read('THIRD_PARTY_NOTICES.md');
    for (const dependency of ['Codicons', 'html-to-image', 'jsonc-parser', 'pngjs', 'react', 'undici']) {
      expect(notices).toContain(dependency);
    }
  });

  it('keeps source-only and local-sensitive files out of the VSIX or Git history', () => {
    const vscodeIgnore = read('.vscodeignore');
    for (const pattern of [
      'src/**',
      'test/**',
      '.github/**',
      '*.vsix',
      'media/icon.svg',
      'PRODUCT.md',
      'CONTRIBUTING.md',
      'CODE_OF_CONDUCT.md',
    ]) {
      expect(vscodeIgnore).toContain(pattern);
    }

    const gitIgnore = read('.gitignore');
    for (const pattern of ['node_modules/', 'dist/', '*.vsix', '.env', '.env.*', 'artifacts/']) {
      expect(gitIgnore).toContain(pattern);
    }

    const sourceFiles = [
      ...read('test/copilotQuality.test.ts').matchAll(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/gu),
    ];
    expect(sourceFiles).toHaveLength(0);
  });

  it('uses pinned GitHub Actions with least-privilege default permissions', () => {
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const source = read(workflow);
      expect(source).toMatch(/actions\/checkout@[0-9a-f]{40}/u);
      expect(source).toMatch(/actions\/setup-node@[0-9a-f]{40}/u);
      expect(source).toContain('node-version: 24');
      expect(source).not.toMatch(/uses:\s+[^\n]+@(main|master|v\d+)\s*$/gmu);
    }
    expect(read('.github/workflows/ci.yml')).toContain('permissions:\n  contents: read');
    expect(read('.github/workflows/release.yml')).toContain('permissions: {}');
  });
});
