import splitModel from './lib';

console.debug('loading gui...')

async function startRenderer(loadingMessage: HTMLElement, main: HTMLElement): Promise<void> {
    // remove loading message
    loadingMessage.parentElement?.removeChild(loadingMessage);

    // setup UI
    main.style.display = '';
    const msg = document.createElement('p');
    msg.textContent = 'Loaded';
    main.appendChild(msg);
}

startRenderer(document.getElementById('loading-msg')!, document.getElementById('main')!);