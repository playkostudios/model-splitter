import { parseTextureSize } from '../base/parseTextureSize';
import { Verbosity } from '@gltf-transform/core';
import { InvalidInputError, CollisionError } from '../base/ModelSplitterError';
import { getDefaultGltfpackPath } from '../base/getDefaultGltfpackPath';
// expose node-notifier's notify function
import { notify } from 'node-notifier';

import type { ModelSplitterError } from '../base/ModelSplitterError';
import type { BasisUniversalMode, LODConfigList, SplitModelOptions } from '../base/external-types';
import type { notify as _notify } from 'node-notifier';
import type { ObjectLoggerMessage, ObjectLoggerMessageType } from '../base/ObjectLogger';
import type { WorkerMessage, WorkerMessageRequest } from '../worker/worker-types';

type LoggerCallback = (message: ObjectLoggerMessage) => void;
type ResolveFunction = CallableFunction;
type RejectFunction = (err: unknown) => void;
const jobs = new Map<number, [resolve: ResolveFunction, reject: RejectFunction]>();
let nextJobID = 0;

const LOD_ROW_ELEM_OFFSET = 8;
const LOD_ROW_ELEM_COUNT = 11;

function logErr(loggerCallback: LoggerCallback, data: string) {
    console.error(data);
    loggerCallback({ type: 'error', data, time: Date.now() });
}

function getWorker(loggerCallback: LoggerCallback, initCallback: CallableFunction, crashCallback: (err: string) => void) {
    const worker = new Worker('./worker-bundle.js');

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;

        if (message.msgType === 'log') {
            loggerCallback(message);
        } else if (message.msgType === 'done') {
            const jobTuple = jobs.get(message.job);
            if (jobTuple === undefined) {
                logErr(loggerCallback, `Unknown job ID "${message.job}" from worker`);
                return;
            }

            const [resolve, reject] = jobTuple;
            jobs.delete(message.job);

            if (message.errorType !== null) {
                if (message.errorType === 'invalid-input') {
                    reject(new InvalidInputError(message.error as string));
                } else if (message.errorType === 'collision') {
                    reject(new CollisionError(message.error as string));
                } else {
                    reject(new Error(message.error));
                }
            } else {
                resolve();
            }
        } else if (message.msgType === 'init') {
            initCallback();
        }else {
            logErr(loggerCallback, `Unknown message type "${message.msgType}" from worker`);
        }
    };

    worker.onerror = (event) => {
        if (event.error === null) {
            crashCallback('Worker crashed, but no error was passed. Check the console');
        } else {
            crashCallback(`Worker crashed with error: ${event.error}`);
        }
    };

    return worker;
}

// make wrapper for splitModel that calls worker instead of directly calling
// splitModel. this is needed so that the main thread isn't blocked, and so that
// dependencies that use webassembly modules with sizes greater than 4KB and
// don't use `initialize` can be loaded
function splitModel(inputModelPath: string, outputFolder: string, lods: LODConfigList, options: SplitModelOptions, worker: Worker): Promise<void> {
    return new Promise((resolve, reject) => {
        const job = nextJobID++;
        jobs.set(job, [resolve, reject]);

        worker.postMessage(<WorkerMessageRequest>{
            msgType: 'request', job, inputModelPath, outputFolder, lods, options
        });
    });
}

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

function log(textOutput: HTMLDivElement, scrollPin: HTMLDivElement, logLevel: Verbosity, mType: ObjectLoggerMessageType, timestamp: number | null, ...messages: Array<unknown>) {
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
    const msgTypeClass = `msg-${mType}`;
    msgContainer.className = msgTypeClass;
    msgContainer.appendChild(msgTimestamp);
    msgContainer.append(messages.join(' '));

    if (logLevel > parseMsgTypeClass(msgTypeClass)) {
        msgContainer.classList.add('hidden');
    }

    textOutput.insertBefore(msgContainer, scrollPin);
}

function logObj(textOutput: HTMLDivElement, scrollPin: HTMLDivElement, logLevel: Verbosity, message: ObjectLoggerMessage) {
    log(textOutput, scrollPin, logLevel, message.type, message.time, message.data);
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

function parseMsgTypeClass(msgTypeClass: string): Verbosity {
    if (msgTypeClass === 'msg-error') {
        return Verbosity.ERROR;
    } else if (msgTypeClass === 'msg-warn') {
        return Verbosity.WARN;
    } else if (msgTypeClass === 'msg-info') {
        return Verbosity.INFO;
    } else {
        return Verbosity.DEBUG;
    }
}

function parseLogLevel(select: HTMLSelectElement): Verbosity {
    const val = select.value;
    if (val === 'error') {
        return Verbosity.ERROR;
    } else if (val === 'warning') {
        return Verbosity.WARN;
    } else if (val === 'info') {
        return Verbosity.INFO;
    } else {
        return Verbosity.DEBUG;
    }
}

async function startRenderer(main: HTMLElement): Promise<void> {
    // get elements
    const inputModelPicker = getElement<HTMLInputElement>('input-model-picker');
    const inputModelInput = getElement<HTMLInputElement>('input-model-input');
    const inputModelButton = getElement<HTMLButtonElement>('input-model-button');

    const outputFolderPicker = getElement<HTMLInputElement>('output-folder-picker');
    const outputFolderInput = getElement<HTMLInputElement>('output-folder-input');
    const outputFolderButton = getElement<HTMLButtonElement>('output-folder-button');

    const gltfpackBinPicker = getElement<HTMLInputElement>('gltfpack-bin-picker');
    const gltfpackBinInput = getElement<HTMLInputElement>('gltfpack-bin-input');
    const gltfpackBinButton = getElement<HTMLButtonElement>('gltfpack-bin-button');

    const embedTexturesInput = getElement<HTMLInputElement>('embed-textures-input');
    const forceInput = getElement<HTMLInputElement>('force-input');
    const optimizeSceneHierarchyInput = getElement<HTMLInputElement>('optimize-scene-hierarchy-input');
    const mergeMaterialsInput = getElement<HTMLInputElement>('merge-materials-input');
    const aggressiveInput = getElement<HTMLInputElement>('aggressive-input');
    const basisUniversalSelect = getElement<HTMLSelectElement>('basis-universal-input');
    const splitDepthInput = getElement<HTMLInputElement>('split-depth-input');
    const resetPositionInput = getElement<HTMLInputElement>('reset-position-input');
    const resetRotationInput = getElement<HTMLInputElement>('reset-rotation-input');
    const resetScaleInput = getElement<HTMLInputElement>('reset-scale-input');
    const createInstanceGroupInput = getElement<HTMLInputElement>('create-instance-group-input');
    const discardDepthSplitParentNodesInput = getElement<HTMLInputElement>('discard-depth-split-parent-nodes-input');

    const defaultTextureSizeInput = getElement<HTMLInputElement>('default-texture-size-input');
    let lastValidDefaultTextureSize = defaultTextureSizeInput.value;

    const addLodButton = getElement<HTMLButtonElement>('add-lod-button');
    const lodListHelp = getElement<HTMLParagraphElement>('lod-list-help');
    const lodList = getElement<HTMLDivElement>('lod-list');

    const logLevelSelect = getElement<HTMLSelectElement>('log-level');
    const clearTextOutputButton = getElement<HTMLButtonElement>('clear-text-output-button');
    const toggleTextOutputButton = getElement<HTMLButtonElement>('toggle-text-output-button');
    const textOutput = getElement<HTMLDivElement>('text-output');
    const scrollPin = getElement<HTMLDivElement>('scroll-pin');
    const depthSplitExtra = getElement<HTMLDivElement>('depth-split-extra');

    const splitButton = getElement<HTMLButtonElement>('split-button');

    // add event listeners
    splitDepthInput.addEventListener('change', () => {
        const splitDepth = splitDepthInput.valueAsNumber;
        depthSplitExtra.style.display = (Number.isInteger(splitDepth) && splitDepth > 0) ? '' : 'none';
    });

    let logLevel = parseLogLevel(logLevelSelect);
    logLevelSelect.addEventListener('change', () => {
        logLevel = parseLogLevel(logLevelSelect);

        for (const message of Array.from(textOutput.children)) {
            if (message.id === 'scroll-pin') {
                continue;
            }

            let msgTypeClass = Verbosity.DEBUG;
            for (const msgClass of Array.from(message.classList)) {
                if (msgClass.startsWith('msg-')) {
                    msgTypeClass = parseMsgTypeClass(msgClass);
                }
            }

            if (logLevel > msgTypeClass) {
                message.classList.add('hidden');
            } else {
                message.classList.remove('hidden');
            }
        }
    });

    defaultTextureSizeInput.addEventListener('change', () => {
        // validate texture size. switch to old value if new value is invalid
        try {
            parseTextureSize(defaultTextureSizeInput.value, false);
            lastValidDefaultTextureSize = defaultTextureSizeInput.value;
        } catch(err) {
            defaultTextureSizeInput.value = lastValidDefaultTextureSize;
        }
    });

    let workerInitDone = false;

    setTimeout(() => {
        if (!workerInitDone) {
            log(textOutput, scrollPin, logLevel, 'warn', null, "10 seconds have passed and the worker hasn't initialized yet. Worker may have silently failed to initialize. Check console for details");
            toggleTextOutput(toggleTextOutputButton, textOutput, true);
        }
    }, 10000);

    const worker = getWorker((message: ObjectLoggerMessage) => {
        logObj(textOutput, scrollPin, logLevel, message);
    }, () => {
        if (!workerInitDone) {
            workerInitDone = true;
            splitButton.disabled = false;
            log(textOutput, scrollPin, logLevel, 'info', null, 'Worker initialized');
        }
    }, (err: string) => {
        workerInitDone = true;
        splitButton.disabled = true;
        logErr(logObj.bind(null, textOutput, scrollPin, logLevel), err);
        toggleTextOutput(toggleTextOutputButton, textOutput, true);
    });

    splitButton.addEventListener('click', async () => {
        splitButton.disabled = true;
        log(textOutput, scrollPin, logLevel, 'info', null, `Splitting model...`);

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

            const gltfpackPath = gltfpackBinInput.value;
            if (gltfpackPath === '') {
                log(textOutput, scrollPin, logLevel, 'warn', null, `No gltfpack binary specified. Assuming that the binary is globally accessible via the PATH variable ("${getDefaultGltfpackPath()}")`);
            }

            const force = forceInput.checked;
            const defaultEmbedTextures = embedTexturesInput.checked;
            const defaultOptimizeSceneHierarchy = optimizeSceneHierarchyInput.checked;
            const defaultMergeMaterials = mergeMaterialsInput.checked;
            const defaultAggressive = aggressiveInput.checked;
            const defaultBasisUniversal = basisUniversalSelect.value as BasisUniversalMode;
            const splitDepth = splitDepthInput.valueAsNumber;
            const resetPosition = resetPositionInput.checked;
            const resetRotation = resetRotationInput.checked;
            const resetScale = resetScaleInput.checked;
            const createInstanceGroup = createInstanceGroupInput.checked;
            let discardDepthSplitParentNodes = discardDepthSplitParentNodesInput.checked;

            if (lodList.children.length <= LOD_ROW_ELEM_OFFSET) {
                throw new Error('Nothing to do; no LODs added');
            }

            if (!Number.isInteger(splitDepth)) {
                throw new Error('Split depth is not a valid integer');
            } else if (splitDepth < 0) {
                throw new Error('Split depth must be greater or equal to zero');
            }

            if (splitDepth === 0) {
                discardDepthSplitParentNodes = false;
            }

            const defaultTextureResizing = parseTextureSize(defaultTextureSizeInput.value, false);

            const lods: LODConfigList = [];
            const children = lodList.children;
            const childCount = children.length;
            for (let i = LOD_ROW_ELEM_OFFSET; i < childCount; i += LOD_ROW_ELEM_COUNT) {
                const textureSize = children[i + 5] as HTMLInputElement;
                const textureResizing = parseTextureSize(textureSize.value, true);

                const meshQuality = children[i + 4] as HTMLInputElement;
                const lodRatioStr = meshQuality.value;
                const meshLODRatio = Number(lodRatioStr.substring(0, lodRatioStr.length - 1)) / 100;

                let embedTextures: boolean | null = null;
                const embedTexturesIn = children[i + 6] as HTMLSelectElement;
                if (embedTexturesIn.value === 'embedded') {
                    embedTextures = true;
                } else if (embedTexturesIn.value === 'external') {
                    embedTextures = false;
                }

                let optimizeSceneHierarchy: boolean | null = null;
                const optimizeSceneHierarchyIn = children[i + 7] as HTMLSelectElement;
                if (optimizeSceneHierarchyIn.value === 'optimize') {
                    optimizeSceneHierarchy = true;
                } else if (optimizeSceneHierarchyIn.value === 'keep') {
                    optimizeSceneHierarchy = false;
                }

                let mergeMaterials: boolean | null = null;
                const materialMergingIn = children[i + 8] as HTMLSelectElement;
                if (materialMergingIn.value === 'merge') {
                    mergeMaterials = true;
                } else if (materialMergingIn.value === 'keep') {
                    mergeMaterials = false;
                }

                let aggressive: boolean | null = null;
                const aggressiveIn = children[i + 9] as HTMLSelectElement;
                if (aggressiveIn.value === 'aggressive') {
                    aggressive = true;
                } else if (aggressiveIn.value === 'not-aggressive') {
                    aggressive = false;
                }

                let basisUniversal: BasisUniversalMode | null = null;
                const basisUniversalIn = children[i + 10] as HTMLSelectElement;
                if (basisUniversalIn.value !== 'default') {
                    basisUniversal = basisUniversalIn.value as BasisUniversalMode;
                }

                lods.push({
                    meshLODRatio, textureResizing, optimizeSceneHierarchy,
                    mergeMaterials, embedTextures, aggressive, basisUniversal
                });
            }

            // split model
            try {
                await splitModel(inputPath, outputPath, lods, {
                    defaultEmbedTextures, defaultTextureResizing,
                    defaultOptimizeSceneHierarchy, defaultMergeMaterials,
                    defaultAggressive, defaultBasisUniversal, gltfpackPath,
                    splitDepth, resetPosition, resetRotation, resetScale,
                    createInstanceGroup, discardDepthSplitParentNodes,
                    force
                }, worker);
            } catch(err: unknown) {
                assertCollisionError(err);

                if (await showModal('Some existing files will be replaced! Run anyway?', true)) {
                    await splitModel(inputPath, outputPath, lods, {
                        defaultEmbedTextures, defaultTextureResizing,
                        defaultOptimizeSceneHierarchy, defaultMergeMaterials,
                        defaultAggressive, defaultBasisUniversal, gltfpackPath,
                        splitDepth, resetPosition, resetRotation, resetScale,
                        createInstanceGroup, discardDepthSplitParentNodes,
                        force: true
                    }, worker);
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
        let message: string;
        if (hadError) {
            if (typeof error === 'object' && error !== null && 'message' in error) {
                log(textOutput, scrollPin, logLevel, 'error', null, error.message);
            } else {
                log(textOutput, scrollPin, logLevel, 'error', null, `${error}`);
            }

            message = 'Failed to split model';
        } else {
            message = 'Done splitting model';
        }

        log(textOutput, scrollPin, logLevel, 'info', null, message);

        if (!document.hasFocus()) {
            notify({ title: 'model-splitter', message });
        } else {
            showModal(message, false);
        }

        splitButton.disabled = false;
    });

    clearTextOutputButton.addEventListener(
        'click',
        () => {
            for (const child of Array.from(textOutput.childNodes)) {
                if ((child as HTMLElement).id !== 'scroll-pin') {
                    textOutput.removeChild(child);
                }
            }
        }
    )

    toggleTextOutputButton.addEventListener(
        'click',
        toggleTextOutput.bind(null, toggleTextOutputButton, textOutput, null)
    );

    setupFileFolderPicker(inputModelPicker, inputModelInput, inputModelButton);
    setupFileFolderPicker(outputFolderPicker, outputFolderInput, outputFolderButton);
    setupFileFolderPicker(gltfpackBinPicker, gltfpackBinInput, gltfpackBinButton);

    const lodListChildren = lodList.children;
    const meshQualityTooltip = (lodListChildren[1] as HTMLElement).title;
    const textureSizeTooltip = (lodListChildren[2] as HTMLElement).title;
    const textureEmbedTooltip = (lodListChildren[3] as HTMLElement).title;
    const sceneHierarchyTooltip = (lodListChildren[4] as HTMLElement).title;
    const materialMergingTooltip = (lodListChildren[5] as HTMLElement).title;
    const aggressivityTooltip = (lodListChildren[6] as HTMLElement).title;
    const basisUniversalTooltip = (lodListChildren[7] as HTMLElement).title;

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
        meshQuality.type = 'text';
        meshQuality.value = '100%';
        meshQuality.title = meshQualityTooltip;
        lodList.appendChild(meshQuality);

        const textureSize = document.createElement('input');
        textureSize.type = 'text';
        textureSize.value = 'default';
        textureSize.title = textureSizeTooltip;
        lodList.appendChild(textureSize);

        const textureEmbed = makeDropdown(['default', 'embedded', 'external']);
        textureEmbed.title = textureEmbedTooltip;
        lodList.appendChild(textureEmbed);

        const sceneHierarchy = makeDropdown(['default', 'optimize', 'keep']);
        sceneHierarchy.title = sceneHierarchyTooltip;
        lodList.appendChild(sceneHierarchy);

        const materialMerging = makeDropdown(['default', 'merge', 'keep']);
        materialMerging.title = materialMergingTooltip;
        lodList.appendChild(materialMerging);

        const aggressive = makeDropdown(['default', 'aggressive', 'not-aggressive']);
        aggressive.title = aggressivityTooltip;
        lodList.appendChild(aggressive);

        const basisUniversal = makeDropdown(['default', 'disabled', 'uastc', 'etc1s']);
        basisUniversal.title = basisUniversalTooltip;
        lodList.appendChild(basisUniversal);

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
            lodList.removeChild(textureEmbed);
            lodList.removeChild(sceneHierarchy);
            lodList.removeChild(materialMerging);
            lodList.removeChild(aggressive);
            lodList.removeChild(basisUniversal);

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
    log(textOutput, scrollPin, logLevel, 'info', null, 'Initialised model-splitter GUI');
}

async function setupTool() {
    try {
        await startRenderer(getElement('main'));
    } catch(err) {
        if (typeof err === 'object' && err !== null) {
            loadPara.textContent = `Failed to load tool: ${(err as Record<string, unknown>).message ?? err}`;
        } else {
            loadPara.textContent = `Failed to load tool: ${err}`;
        }

        loadPara.className = 'error';
    }
}

setupTool();