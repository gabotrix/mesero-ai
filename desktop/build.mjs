#!/usr/bin/env node
/**
 * Builds the backend into one executable a restaurant can double-click.
 *
 * Uses Node's own single-executable support rather than a bundler-plus-packager
 * chain: `pkg` has no prebuilt base binary for current Node and falls back to
 * compiling Node from source, which needs Visual Studio. SEA ships inside the
 * Node already installed, so this works on any machine that can run the project
 * at all.
 *
 * It cannot cross-compile — the executable it writes is for the machine that
 * runs this script. That is why the reComputer has its own script rather than a
 * download: an ARM64 appliance builds its own binary in about a minute.
 *
 *   node build.mjs
 */

import { execFileSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { inject } from 'postject';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BUILD = join(HERE, 'build');
const OUT = join(HERE, 'dist', process.platform === 'win32' ? 'win' : 'linux');

const isWindows = process.platform === 'win32';
const exeName = isWindows ? 'mesero-server.exe' : 'mesero-server';

// The CLIs are reached through their JavaScript APIs rather than a shell: this
// project lives under a path with a space in it, and shell:true on Windows does
// not quote arguments, so every call silently lost half its path.
function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

/**
 * npm needs a shell on Windows — Node refuses to spawn a .cmd without one — and
 * a shell does not quote arguments, which matters because this project is
 * perfectly happy living under a path with a space in it. So quote it here.
 */
function runNpm(args, cwd) {
  // `cwd`, never `--prefix`. With --prefix npm still reads the *current*
  // directory's package as something to install, and quietly wrote this build
  // tool into the backend's dependencies.
  execFileSync('npm', args, { stdio: 'inherit', shell: true, cwd });
}

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
mkdirSync(OUT, { recursive: true });

// The bundler resolves the backend's own imports, so its dependencies have to be
// on disk. Failing with "Could not resolve ws" tells a newcomer nothing.
if (!existsSync(join(ROOT, 'backend', 'node_modules'))) {
  console.log('\n0/4  Instalando dependencias del backend…');
  runNpm(['install', '--omit=dev'], join(ROOT, 'backend'));
}

console.log('\n1/4  Empaquetando el backend en un solo archivo…');
await esbuild({
  entryPoints: [join(ROOT, 'backend', 'src', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  logOverride: { 'empty-import-meta': 'silent' },
  outfile: join(BUILD, 'mesero-server.cjs'),
});

console.log('2/4  Preparando el blob…');
writeFileSync(
  join(BUILD, 'sea-config.json'),
  JSON.stringify(
    {
      main: join(BUILD, 'mesero-server.cjs'),
      output: join(BUILD, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);
run(process.execPath, ['--experimental-sea-config', join(BUILD, 'sea-config.json')]);

console.log('3/4  Inyectando en el ejecutable…');
const target = join(OUT, exeName);
copyFileSync(process.execPath, target);
await inject(target, 'NODE_SEA_BLOB', readFileSync(join(BUILD, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: 'NODE_SEA',
});

console.log('4/4  Copiando lo que el restaurante puede editar…');
// These stay outside the executable on purpose: a menu edit or a re-pointed
// backend must not require rebuilding anything.
cpSync(join(ROOT, 'web'), join(OUT, 'web'), { recursive: true });
mkdirSync(join(OUT, 'backend'), { recursive: true });
copyFileSync(join(ROOT, 'backend', 'menu.json'), join(OUT, 'backend', 'menu.json'));
if (!existsSync(join(OUT, '.env'))) {
  copyFileSync(join(ROOT, '.env.example'), join(OUT, '.env'));
}

console.log(`\nListo: ${target}`);
console.log('Junto a él quedaron .env, backend/menu.json y web/ — editables sin recompilar.\n');
