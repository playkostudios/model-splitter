import { BuildOptions } from 'esbuild'
import * as path from 'path'

const config: BuildOptions = {
  platform: 'node',
  entryPoints: [
    path.resolve('src/gui/main/main.ts'),
    path.resolve('src/gui/main/preload.ts'),
  ],
  bundle: true,
  target: 'node16.15.0', // electron version target
}

export default config
