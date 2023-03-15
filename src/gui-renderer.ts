import { parseTextureSize } from './common';

import type { LODConfigList, ModelSplitterError, CollisionError } from './lib';
import type { notify as _notify } from 'node-notifier';
import type { WrappedSplitModel } from './WrappedSplitModel';
import type { ObjectLoggerMessage, ObjectLoggerMessageType } from './ObjectLogger';

type Notify = typeof _notify;

const LOD_ROW_ELEM_OFFSET = 5;
const LOD_ROW_ELEM_COUNT = 8;

function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
    // WARN this fails fast
    const elem = document.getElementById(id);
    if (elem === null) {
        throw new Error(`Element with ID "${id}" not found`);
    }

    return elem as T;
}

function assertCollisionError(err: unknown): asserts err is CollisionError {
    if (typeof err !== 'object') {
        throw err;
    }

    if (!(err as ModelSplitterError<string>).isModelSplitterError) {
        throw err;
    }

    const msErr = err as ModelSplitterError<string>;
    if (msErr.modelSplitterType !== 'collision') {
        throw err;
    }
}

const loadPara = getElement('loading-msg');

function toggleTextOutput(button: HTMLButtonElement, content: HTMLDivElement, show: boolean | null) {
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
    const children = lodList.children;
    const rowCount = (children.length - LOD_ROW_ELEM_OFFSET) / LOD_ROW_ELEM_COUNT;
    for (let i = 0; i < rowCount; i++) {
        const j = LOD_ROW_ELEM_OFFSET + i * LOD_ROW_ELEM_COUNT;

        // update LOD ID
        children[j + 3].textContent = `LOD${i}`;

        // disable up button if at top
        if (i === 0) {
            children[j].classList.add('disabled-icon-button');
        } else {
            children[j].classList.remove('disabled-icon-button');
        }

        // disable down button if at top
        if (i === (rowCount - 1)) {
            children[j + 1].classList.add('disabled-icon-button');
        } else {
            children[j + 1].classList.remove('disabled-icon-button');
        }
    }

    // show help if no lods present
    lodList.style.display = (rowCount === 0) ? 'none' : '';
    lodListHelp.style.display = (rowCount === 0) ? '' : 'none';
}

function reorderLODRow(lodList: HTMLDivElement, lodListHelp: HTMLParagraphElement, lodRowFirstElem: HTMLElement, delta: number) {
    // find new index in list
    const rows = lodList.children;
    let i = LOD_ROW_ELEM_OFFSET;
    for (; i < rows.length; i += LOD_ROW_ELEM_COUNT) {
        if (rows[i] === lodRowFirstElem) {
            break;
        }
    }

    i += delta;

    // validate new index
    if (i < LOD_ROW_ELEM_OFFSET) {
        return;
    }

    // move
    const movables = [lodRowFirstElem];
    for (let j = 1, focus = lodRowFirstElem; j < LOD_ROW_ELEM_COUNT; j++) {
        focus = focus.nextElementSibling as HTMLElement;
        movables.push(focus);
    }

    const moveBefore = rows[i];
    for (const movable of movables) {
        lodList.insertBefore(movable, moveBefore);
    }

    updateLODRows(lodList, lodListHelp);
}

function log(textOutput: HTMLDivElement, mType: ObjectLoggerMessageType, timestamp: number | null, ...messages: Array<unknown>) {
    if (mType === 'errorString') {
        mType = 'error';
    }

    let timestampStr: string;
    if (timestamp === null) {
        timestampStr = new Date().toISOString();
    } else {
        timestampStr = new Date(timestamp).toISOString();
    }

    const msgTimestamp = document.createElement('span');
    msgTimestamp.className = 'msg-timestamp';
    msgTimestamp.textContent = timestampStr;

    const msgContainer = document.createElement('p');
    msgContainer.className = `msg-${mType}`;
    msgContainer.appendChild(msgTimestamp);
    msgContainer.append(messages.join(' '));

    textOutput.appendChild(msgContainer);
}

function logObj(textOutput: HTMLDivElement, messages: Array<ObjectLoggerMessage>) {
    for (const message of messages) {
        log(textOutput, message.type, message.time, message.data);
    }
}

async function showModal(question: string, isQuestion: boolean): Promise<boolean> {
    if (isQuestion) {
        return confirm(question);
    } else {
        alert(question);
        return true;
    }
}

function makeIconButton(iconSrc: string): HTMLImageElement {
    const img = document.createElement('img');
    img.src = iconSrc;
    img.className = 'icon-button';
    return img;
}

function makeDropdown(options: Array<string>): HTMLSelectElement {
    const sel = document.createElement('select');

    for (const optName of options) {
        const opt = document.createElement('option');
        opt.value = optName;
        opt.textContent = optName;
        sel.appendChild(opt);
    }

    return sel;
}

async function startRenderer(splitModel: WrappedSplitModel, notify: Notify, main: HTMLElement): Promise<void> {
    // get elements
    const inputModelPicker = getElement<HTMLInputElement>('input-model-picker');
    const inputModelInput = getElement<HTMLInputElement>('input-model-input');
    const inputModelButton = getElement<HTMLButtonElement>('input-model-button');

    const outputFolderPicker = getElement<HTMLInputElement>('output-folder-picker');
    const outputFolderInput = getElement<HTMLInputElement>('output-folder-input');
    const outputFolderButton = getElement<HTMLButtonElement>('output-folder-button');

    const embedTexturesInput = getElement<HTMLInputElement>('embed-textures-input');
    const forceInput = getElement<HTMLInputElement>('force-input');
    const keepSceneHierarchyInput = getElement<HTMLInputElement>('keep-scene-hierarchy-input');
    const noMaterialMergingInput = getElement<HTMLInputElement>('no-material-merging-input');

    const defaultTextureSizeInput = getElement<HTMLInputElement>('default-texture-size-input');
    let lastValidDefaultTextureSize = defaultTextureSizeInput.value;

    const addLodButton = getElement<HTMLButtonElement>('add-lod-button');
    const lodListHelp = getElement<HTMLParagraphElement>('lod-list-help');
    const lodList = getElement<HTMLDivElement>('lod-list');

    const clearTextOutputButton = getElement<HTMLButtonElement>('clear-text-output-button');
    const toggleTextOutputButton = getElement<HTMLButtonElement>('toggle-text-output-button');
    const textOutput = getElement<HTMLDivElement>('text-output');

    const splitButton = getElement<HTMLButtonElement>('split-button');

    // add event listeners
    defaultTextureSizeInput.addEventListener('change', () => {
        // validate texture size. switch to old value if new value is invalid
        try {
            parseTextureSize(defaultTextureSizeInput.value, false);
            lastValidDefaultTextureSize = defaultTextureSizeInput.value;
        } catch(err) {
            defaultTextureSizeInput.value = lastValidDefaultTextureSize;
        }
    });

    splitButton.addEventListener('click', async () => {
        splitButton.disabled = true;
        log(textOutput, 'log', null, `Splitting model...`);

        const messages = new Array<ObjectLoggerMessage>();
        let error: unknown;
        let hadError = false;

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

            const force = forceInput.checked;
            const embedTextures = embedTexturesInput.checked;
            const defaultKeepSceneHierarchy = keepSceneHierarchyInput.checked;
            const defaultNoMaterialMerging = noMaterialMergingInput.checked;

            if (lodList.children.length <= LOD_ROW_ELEM_OFFSET) {
                throw new Error('Nothing to do; no LODs added');
            }

            const defaultResizeOpt = parseTextureSize(defaultTextureSizeInput.value, false);

            const lods: LODConfigList = [];
            const children = lodList.children;
            const childCount = children.length;
            for (let i = LOD_ROW_ELEM_OFFSET; i < childCount; i += LOD_ROW_ELEM_COUNT) {
                const textureSize = children[i + 5] as HTMLInputElement;
                const texSize = parseTextureSize(textureSize.value, true);

                const meshQuality = children[i + 4] as HTMLInputElement;
                const lodRatioStr = meshQuality.value;
                const lodRatio = Number(lodRatioStr.substring(0, lodRatioStr.length - 1)) / 100;

                let keepSceneHierarchy: boolean | null = null;
                const keepSceneHierarchyIn = children[i + 6] as HTMLSelectElement;
                if (keepSceneHierarchyIn.value === 'optimize') {
                    keepSceneHierarchy = false;
                } else if (keepSceneHierarchyIn.value === 'keep') {
                    keepSceneHierarchy = true;
                }

                let noMaterialMerging: boolean | null = null;
                const noMaterialMergingIn = children[i + 6] as HTMLSelectElement;
                if (noMaterialMergingIn.value === 'enable') {
                    noMaterialMerging = false;
                } else if (noMaterialMergingIn.value === 'disable') {
                    noMaterialMerging = true;
                }

                lods.push([lodRatio, texSize, keepSceneHierarchy, noMaterialMerging]);
            }

            // split model
            try {
                await splitModel(inputPath, outputPath, lods, {
                    embedTextures, defaultResizeOpt, defaultKeepSceneHierarchy,
                    defaultNoMaterialMerging, force
                }, messages);
            } catch(err: unknown) {
                assertCollisionError(err);

                if (await showModal('Some existing files will be replaced! Run anyway?', true)) {
                    await splitModel(inputPath, outputPath, lods, {
                        embedTextures, defaultResizeOpt, force: true,
                        defaultKeepSceneHierarchy, defaultNoMaterialMerging
                    }, messages);
                } else {
                    throw err;
                }
            }
        } catch(err) {
            error = err;
            hadError = true;
            toggleTextOutput(toggleTextOutputButton, textOutput, true);
        }

        // output messages
        logObj(textOutput, messages);

        let message: string;
        if (hadError) {
            if (typeof error === 'object' && error !== null && 'message' in error) {
                log(textOutput, 'errorString', null, error.message);
            } else {
                log(textOutput, 'error', null, error);
            }

            message = 'Failed to split model';
        } else {
            message = 'Done splitting model';
        }

        log(textOutput, 'log', null, message);
        showModal(message, false);

        if (!document.hasFocus()) {
            notify({ title: 'model-splitter', message });
        }

        splitButton.disabled = false;
    });

    clearTextOutputButton.addEventListener(
        'click',
        () => {
            for (const child of Array.from(textOutput.childNodes.values())) {
                textOutput.removeChild(child);
            }
        }
    )

    toggleTextOutputButton.addEventListener(
        'click',
        toggleTextOutput.bind(this, toggleTextOutputButton, textOutput, null)
    );

    setupFileFolderPicker(inputModelPicker, inputModelInput, inputModelButton);
    setupFileFolderPicker(outputFolderPicker, outputFolderInput, outputFolderButton);

    const lodListChildren = lodList.children;
    const meshQualityTooltip = (lodListChildren[1] as HTMLElement).title;
    const textureSizeTooltip = (lodListChildren[2] as HTMLElement).title;
    const sceneHierarchyTooltip = (lodListChildren[3] as HTMLElement).title;
    const materialMergingTooltip = (lodListChildren[4] as HTMLElement).title;

    addLodButton.addEventListener('click', () => {
        const upButton = makeIconButton('up-icon.svg');
        lodList.appendChild(upButton);

        const downButton = makeIconButton('down-icon.svg');
        lodList.appendChild(downButton);

        const removeButton = makeIconButton('remove-icon.svg');
        lodList.appendChild(removeButton);

        const label = document.createElement('span');
        lodList.appendChild(label);

        const meshQuality = document.createElement('input');
        meshQuality.type = 'string';
        meshQuality.value = '100%';
        meshQuality.title = meshQualityTooltip;
        lodList.appendChild(meshQuality);

        const textureSize = document.createElement('input');
        textureSize.type = 'string';
        textureSize.value = 'default';
        textureSize.title = textureSizeTooltip;
        lodList.appendChild(textureSize);

        const sceneHierarchy = makeDropdown(['default', 'optimize', 'keep']);
        sceneHierarchy.title = sceneHierarchyTooltip;
        lodList.appendChild(sceneHierarchy);

        const materialMerging = makeDropdown(['default', 'enable', 'disable']);
        materialMerging.title = materialMergingTooltip;
        lodList.appendChild(materialMerging);

        let lastValidTextureSize = textureSize.value;
        textureSize.addEventListener('change', () => {
            // validate texture size. switch to old value if new value is
            // invalid
            try {
                parseTextureSize(textureSize.value, true);
                lastValidTextureSize = textureSize.value;
            } catch(err) {
                textureSize.value = lastValidTextureSize;
            }
        });

        upButton.addEventListener('click', () => reorderLODRow(lodList, lodListHelp, upButton, -LOD_ROW_ELEM_COUNT));
        downButton.addEventListener('click', () => reorderLODRow(lodList, lodListHelp, upButton, 2 * LOD_ROW_ELEM_COUNT));
        removeButton.addEventListener('click', () => {
            lodList.removeChild(upButton);
            lodList.removeChild(downButton);
            lodList.removeChild(removeButton);
            lodList.removeChild(label);
            lodList.removeChild(meshQuality);
            lodList.removeChild(textureSize);
            lodList.removeChild(sceneHierarchy);
            lodList.removeChild(materialMerging);

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

        updateLODRows(lodList, lodListHelp);
    })

    // remove loading message and show UI
    loadPara.parentElement?.removeChild(loadPara);
    main.style.display = '';
    log(textOutput, 'log', null, 'Initialised model-splitter GUI');
}

async function setupTool() {
    try {
        const main = getElement('main');

        // load splitModel and notify functions
        let splitModel: WrappedSplitModel;
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