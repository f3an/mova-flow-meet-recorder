import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/background.ts', 'src/offscreen.ts', 'src/popup.ts', 'src/content.ts'],
  bundle: true,
  outdir: 'dist',
  platform: 'browser',
  format: 'iife',
  target: 'chrome110',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(options);
  console.log('Build complete.');
}
