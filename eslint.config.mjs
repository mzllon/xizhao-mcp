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
  {
    rules: {
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'ts/no-explicit-any': 'off',
    },
  },
)
