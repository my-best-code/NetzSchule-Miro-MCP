import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Mirror esbuild's `loader: { '.md': 'text' }` so modules importing
    // markdown (e.g. src/mcp/lambda.ts) can be loaded in tests
    {
      name: 'markdown-as-string',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('.md')) {
          return {
            code: `export default ${JSON.stringify(code)};`,
            map: null,
          };
        }
      },
    },
  ],
});
