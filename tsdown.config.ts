import type { UserConfig } from 'tsdown'

/**
 * One Node entry. No client entry yet: the display chain currently relies on
 * the Host's generic tool card, and a keyed `tool.call.toolview` (the only way
 * to render a generated image inside the card) is deliberately left to the
 * next step — see README「展示链现状」.
 *
 * `neverBundle` mirrors the main plugin: Host-provided packages are resolved at
 * load time from the profile, never inlined into `lib/`.
 */
export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-llm',
        'dsh-connect-comate',
      ],
    },
  },
] satisfies UserConfig[]
