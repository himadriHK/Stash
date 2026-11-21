import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/server/index.ts',
    'workers/hash.worker': 'src/workers/hash.worker.ts',
    'workers/media.worker': 'src/workers/media.worker.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist/server',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  external: [
    'better-sqlite3',
    'sharp',
    '@confluentinc/kafka-javascript',
    'lightdrift-libraw',
    'heic-decode',
    'ffmpeg-static',
    'ffprobe-static',
  ],
});
