import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'demo',
  base: '/play/mml-fm-audio/',
  build: {
    // out 直下にすると、パス付きルートの Workers では deploy が失敗する（character-tactics と同じ）
    outDir: '../out/play/mml-fm-audio',
    emptyOutDir: true,
  },
  test: {
    // root を demo にしているため、テストはリポジトリ全体から探すよう明示する
    root: repoRoot,
    globals: true,
    environment: 'node',
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
