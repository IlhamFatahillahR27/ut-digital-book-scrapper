import { defineConfig } from 'vite';
import path from 'path';

// Standard Vite config for IDE and tooling support
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  }
});
