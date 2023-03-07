import type { ResizeOption } from 'gm';
import type { default as _SplitModel, LODConfigList, PackedResizeOption } from './lib';
import type { notify as _notify } from 'node-notifier';

type SplitModel = typeof _SplitModel;
type Notify = typeof _notify;

function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
    // WARN this fails fast
    const elem = document.getElementById(id);
    if (elem === null) {
        throw new Error(`Element with ID "${id}" not found`);
    }

    return elem as T;
}

const loadPara = getElement('loading-msg');

function toggleTextOutput(button: HTMLButtonElement, content: HTMLPreElement, show: boolean | null) {
    if (show === null) {
        show = content.style.display === 'none';
    }

    if (show) {
        button.textContent = 'Hide text output';
        content.style.display = '';
    } else {
        button.textContent = 'Show text output';
        content.style.display = 'none';
    }
}

function setupFileFolderPicker(picker: HTMLInputElement, textInput: HTMLInputElement, button: HTMLButtonElement) {
    button.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
        if (picker.value !== '') {
            textInput.value = picker.value;
        }
    });
}

function updateLODRows(lodList: HTMLDivElement, lodListHelp: HTMLParagraphElement) {
    const rows = lodList.children;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const parts = row.children;

        // update LOD ID
        parts[0].textContent = `LOD${i} - `;

        // disable up button if at top
        (parts[1] as HTMLButtonElement).disabled = (i === 0);

        // disable down button if at top
        (parts[2] as HTMLButtonElement).disabled = (i === (rows.length - 1));
    }

    // show help if no lods present
    lodListHelp.style.display = (lodList.children.length === 0) ? '' : 'none';
}

function reorderLODRow(lodList: HTMLDivElement, lodListHelp: HTMLParagraphElement, lodRow: HTMLDivElement, delta: number) {
    // find new index in list
    const rows = lodList.children;
    let i = 0;
    for (; i < rows.length; i++) {
        if (rows[i] === lodRow) {
            break;
        }
    }

    i += delta;

    // validate new index
    if (i < 0) {
        return;
    }

    // move
    lodList.insertBefore(lodRow, rows[i] ?? null);
    updateLODRows(lodList, lodListHelp);
}

function log(textOutput: HTMLPreElement, ...messages: Array<unknown>) {
    const newlinePrefix = textOutput.textContent === '' ? '' : '\n';
    const timestamp = new Date().toISOString();
    textOutput.textContent += `${newlinePrefix}[${timestamp}] ${messages.join(' ')}`;
}

function parseTextureSize(input: HTMLInputElement) {
    let texSizeStr = input.value;
    let texSize: PackedResizeOption | null = null;
    if (texSizeStr !== 'default' && texSizeStr !== 'keep') {
        let option: ResizeOption = '!';
        if (texSizeStr.endsWith('%')) {
            option = '%';
            texSizeStr = texSizeStr.substring(0, texSizeStr.length - 1);
        }

        const parts = texSizeStr.split(/[x,]/);
        if (parts.length <= 0 || parts.length > 2) {
            throw new Error(`Invalid texture size (${input.value})`);
        }

        const partsNum = new Array<number>();
        for (const part of parts) {
            const num = Number(part);
            if (isNaN(num) || !isFinite(num) || num <= 0) {
                throw new Error(`Invalid texture size (${input.value})`);
            }

            partsNum.push(num);
        }

        texSize = [partsNum[0], parts.length === 2 ? partsNum[1] : partsNum[0], option];
    }

    return texSize;
}

async function startRenderer(splitModel: SplitModel, notify: Notify, main: HTMLElement): Promise<void> {
    // get elements
    const inputModelPicker = getElement<HTMLInputElement>('input-model-picker');
    const inputModelInput = getElement<HTMLInputElement>('input-model-input');
    const inputModelButton = getElement<HTMLButtonElement>('input-model-button');

    const outputFolderPicker = getElement<HTMLInputElement>('output-folder-picker');
    const outputFolderInput = getElement<HTMLInputElement>('output-folder-input');
    const outputFolderButton = getElement<HTMLButtonElement>('output-folder-button');

    const embedTexturesInput = getElement<HTMLInputElement>('embed-textures-input');

    const defaultTextureSizeInput = getElement<HTMLInputElement>('default-texture-size-input');

    const addLodButton = getElement<HTMLButtonElement>('add-lod-button');
    const lodListHelp = getElement<HTMLParagraphElement>('lod-list-help');
    const lodList = getElement<HTMLDivElement>('lod-list');

    const toggleTextOutputButton = getElement<HTMLButtonElement>('toggle-text-output-button');
    const textOutput = getElement<HTMLPreElement>('text-output');

    const splitButton = getElement<HTMLButtonElement>('split-button');

    // add event listeners
    splitButton.addEventListener('click', async () => {
        splitButton.disabled = true;
        log(textOutput, `Splitting model...`);

        try {
            // parse inputs
            const inputPath = inputModelInput.value;
            if (inputPath === '') {
                throw new Error('No input model specified');
            }

            const outputPath = outputFolderInput.value;
            if (outputPath === '') {
                throw new Error('No output folder specified');
            }

            const embedTextures = embedTexturesInput.checked;

            if (lodList.children.length === 0) {
                throw new Error('Nothing to do; no LODs added');
            }

            const defaultTexSize = parseTextureSize(defaultTextureSizeInput);

            const lods: LODConfigList = [];
            for (const lodRow of lodList.children) {
                const textureSize = lodRow.children[7] as HTMLInputElement;
                const texSize = parseTextureSize(textureSize);

                const meshQuality = lodRow.children[5] as HTMLInputElement;
                const lodRatioStr = meshQuality.value;
                const lodRatio = Number(lodRatioStr.substring(0, lodRatioStr.length - 1));

                lods.push([lodRatio, texSize]);
            }

            // split model
            await splitModel(inputPath, outputPath, lods, embedTextures, defaultTexSize);
            log(textOutput, 'Done splitting model');
            notify({
                title: 'model-splitter',
                message: 'Done splitting model'
            });
        } catch(err) {
            toggleTextOutput(toggleTextOutputButton, textOutput, true);
            log(textOutput, err.message ?? err);
        } finally {
            splitButton.disabled = false;
        }
    });

    toggleTextOutputButton.addEventListener(
        'click',
        toggleTextOutput.bind(this, toggleTextOutputButton, textOutput, null)
    );

    setupFileFolderPicker(inputModelPicker, inputModelInput, inputModelButton);
    setupFileFolderPicker(outputFolderPicker, outputFolderInput, outputFolderButton);

    let nextID = 0;
    addLodButton.addEventListener('click', () => {
        const lodRow = document.createElement('div');
        lodRow.className = 'lod-row';

        const idNum = nextID++;
        const meshQualityID = `mesh-quality-${idNum}`;
        const textureSizeID = `texture-size-${idNum}`;

        const label = document.createElement('span');
        label.textContent = `LOD${lodList.children.length} - `;
        lodRow.appendChild(label);

        const upButton = document.createElement('button');
        upButton.textContent = '^';
        lodRow.appendChild(upButton);

        const downButton = document.createElement('button');
        downButton.textContent = 'v';
        lodRow.appendChild(downButton);

        const removeButton = document.createElement('button');
        removeButton.textContent = 'X';
        lodRow.appendChild(removeButton);

        const meshQualityLabel = document.createElement('label');
        meshQualityLabel.textContent = 'Mesh quality:';
        meshQualityLabel.htmlFor = meshQualityID;
        lodRow.appendChild(meshQualityLabel);

        const meshQuality = document.createElement('input');
        meshQuality.type = 'string';
        meshQuality.id = meshQualityID;
        meshQuality.value = '100%';
        lodRow.appendChild(meshQuality);

        const textureSizeLabel = document.createElement('label');
        textureSizeLabel.textContent = 'Texture size:';
        textureSizeLabel.htmlFor = textureSizeID;
        lodRow.appendChild(textureSizeLabel);

        const textureSize = document.createElement('input');
        textureSize.type = 'string';
        textureSize.id = textureSizeID;
        textureSize.value = 'default';
        lodRow.appendChild(textureSize);

        upButton.addEventListener('click', () => reorderLODRow(lodList, lodListHelp, lodRow, -1));
        downButton.addEventListener('click', () => reorderLODRow(lodList, lodListHelp, lodRow, 2));
        removeButton.addEventListener('click', () => {
            lodList.removeChild(lodRow);
            updateLODRows(lodList, lodListHelp);
        });

        meshQuality.addEventListener('change', () => {
            let inVal = meshQuality.value;
            if (inVal.endsWith('%')) {
                inVal = inVal.substring(0, inVal.length - 1);
            }

            let inNum = Number(inVal);
            if (isNaN(inNum) || !isFinite(inNum)) {
                inNum = 100;
            } else if (inNum > 100) {
                inNum = 100;
            } else if (inNum < 0) {
                inNum = 0;
            }

            meshQuality.value = `${inNum}%`;
        });

        lodList.appendChild(lodRow);
        updateLODRows(lodList, lodListHelp);
    })

    // remove loading message and show UI
    loadPara.parentElement?.removeChild(loadPara);
    main.style.display = '';
    log(textOutput, 'Initialised model-splitter GUI');
}

async function setupTool() {
    try {
        const main = getElement('main');

        // load splitModel and notify functions
        let splitModel: SplitModel;
        let notify: Notify;
        try {
            ({ splitModel, notify } = require('./main-bundle.js'));
        } catch(err) {
            throw new Error(`Error importing library;\n${err}`);
        }

        // start renderer
        await startRenderer(splitModel, notify, main);
    } catch(err) {
        loadPara.textContent = `Failed to load tool: ${err.message ?? err}`;
        loadPara.className = 'error';
    }
}

setupTool();