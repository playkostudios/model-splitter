import { BuildOptions } from 'esbuild'
import * as path from 'path'

const config: BuildOptions = {
  platform: 'browser',
  entryPoints: [
    path.resolve('src/gui/renderer/index.tsx'),
    path.resolve('src/gui/renderer/index.css'),
  ],
  bundle: true,
  target: 'chrome108', // electron version target
}

export default config
