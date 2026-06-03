import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'module',
    typescript: true,
    markdown: false,
    test: {
      vitest: true,
    },
    ignores: ['dist/', 'node_modules/', '.claude/', '.agents/', '.codex/', 'docs/'],
  },
)
