/**
 * /!\ This file is auto-generated.
 *
 * This is the entry point of your standalone application.
 *
 * There are multiple tags used by the editor to inject code automatically:
 *     - `wle:auto-imports:start` and `wle:auto-imports:end`: The list of import statements
 *     - `wle:auto-register:start` and `wle:auto-register:end`: The list of component to register
 *     - `wle:auto-constants:start` and `wle:auto-constants:end`: The project's constants,
 *        such as the project's name, whether it should use the physx runtime, etc...
 *     - `wle:auto-benchmark:start` and `wle:auto-benchmark:end`: Append the benchmarking code
 */

import {loadRuntime} from '@wonderlandengine/api';
import * as API from '@wonderlandengine/api'; // Deprecated: Backward compatibility.

/* wle:auto-imports:start */
import {MouseLookComponent} from '@wonderlandengine/components';
import {WasdControlsComponent} from '@wonderlandengine/components';
import {ModelLoader} from './model-loader.js';
/* wle:auto-imports:end */

/* wle:auto-constants:start */
const RuntimeOptions = {
    physx: false,
    loader: true,
    xrFramebufferScaleFactor: 1,
    canvas: 'canvas',
};
const Constants = {
    ProjectName: 'model-splitter-example',
    RuntimeBaseName: 'WonderlandRuntime',
    WebXRRequiredFeatures: ['local',],
    WebXROptionalFeatures: ['local','hand-tracking','hit-test',],
};
/* wle:auto-constants:end */

loadRuntime(Constants.RuntimeBaseName, RuntimeOptions).then((engine) => {
    Object.assign(engine, API); // Deprecated: Backward compatibility.
    window.WL = engine; // Deprecated: Backward compatibility.

    engine.onSceneLoaded.push(() => {
        const el = document.getElementById('version');
        if(el) setTimeout(() => el.remove(), 2000);
    });

    const arButton = document.getElementById('ar-button');
    if(arButton) {
        arButton.dataset.supported = engine.arSupported;
    }
    const vrButton = document.getElementById('vr-button');
    if(vrButton) {
        vrButton.dataset.supported = engine.vrSupported;
    }

    /* wle:auto-register:start */
engine.registerComponent(MouseLookComponent);
engine.registerComponent(WasdControlsComponent);
engine.registerComponent(ModelLoader);
/* wle:auto-register:end */

    engine.scene.load(`${Constants.ProjectName}.bin`);

    /* wle:auto-benchmark:start */
/* wle:auto-benchmark:end */
});
