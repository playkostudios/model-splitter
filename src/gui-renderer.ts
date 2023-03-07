import type { default as SplitModel } from './lib';

let splitModel: (typeof SplitModel) | null = null;

try {
    splitModel = require('./main-bundle.js');
} catch(err) {
    console.error('failed to import', err);
}

async function startRenderer(loadingMessage: HTMLElement, main: HTMLElement): Promise<void> {
    // remove loading message
    loadingMessage.parentElement?.removeChild(loadingMessage);

    // setup UI
    main.style.display = '';
    const msg = document.createElement('p');
    msg.textContent = 'Loaded';
    main.appendChild(msg);

    // attempt to call model splitter
    try {
        await splitModel('../model.glb', '../output', [[1, null], [0.75, null], [0.5, [50, 50, '%']], [0.25, [25, 25, '%']]]);
    } catch(err) {
        const errMsg = document.createElement('p');
        errMsg.textContent = `${err}`;
        main.appendChild(errMsg);
    }

    const endMsg = document.createElement('p');
    endMsg.textContent = 'Finished calling splitModel';
    main.appendChild(endMsg);
}

startRenderer(document.getElementById('loading-msg')!, document.getElementById('main')!);