import { Mutex } from 'async-mutex';

/**
 * Modified Basis Universal loader.
 * - converted to Typescript
 * - removed worker code (original script is used)
 * - simplified code for use with Wonderland Engine
 * - modularized
 * - added cdnRoot
 *
 * https://github.com/BinomialLLC/basis_universal/tree/master/webgl/transcoder/build/basis_loader.js
 */

export interface TextureResult {
    width: number,
    height: number,
    texture: WebGLTexture
}

interface WebGLFormat {
    uncompressed: boolean,
    format: number,
    type: number
}

interface SupportedFormats {
    s3tc: boolean,
    etc1: boolean,
    etc2: boolean,
    pvrtc: boolean,
    astc: boolean,
    bptc: boolean
}

const TRI_DATA = new Float32Array([ 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1 ]);

const VERT_SHADER_SRC = `\
#version 300 es
precision lowp float;

layout(location = 0) in vec2 uv;
out vec2 uvPass;

void main()
{
    uvPass      = uv;
    gl_Position = vec4(uv * 2.0 - vec2(1.0, 1.0), 0.0, 1.0);
}\
`;

const FRAG_SHADER_SRC = `\
#version 300 es
precision highp float;

uniform highp sampler2D sampler;
in vec2 uvPass;
out vec4 color;

void main()
{
    color = texture(sampler, uvPass);
}\
`

function loadShader(gl: WebGLRenderingContext, shaderType: number, source: string) {
    const shader = gl.createShader(shaderType);

    if (shader === null) {
        throw new Error('Failed to create shader object');
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const errMsg = `Failed to compile shader: ${gl.getShaderInfoLog(shader)}`;
        gl.deleteShader(shader);
        throw new Error(errMsg);
    }

    return shader;
}

class PendingTextureRequest {
    texture: WebGLTexture | null = null;
    readonly promise: Promise<TextureResult>;

    resolve?: (opts: TextureResult) => void;
    reject?: (err: unknown) => void;

    constructor(public readonly gl: WebGLRenderingContext, public readonly url: string) {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }

    uploadImageData(webglFormat: WebGLFormat, buffer: ArrayBuffer, width: number, height: number) {
        const gl = this.gl;
        const texture = gl.createTexture();

        if (texture === null) {
            throw new Error('Failed to create texture');
        }

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

        let levelData = null;

        // only getting first mip level, since we're rendering a fullscreen quad
        if (!webglFormat.uncompressed) {
            levelData = new Uint8Array(buffer);
            gl.compressedTexImage2D(
                gl.TEXTURE_2D,
                0,
                webglFormat.format,
                width,
                height,
                0,
                levelData
            );
        } else {
            switch (webglFormat.type) {
            case WebGLRenderingContext.UNSIGNED_SHORT_4_4_4_4:
            case WebGLRenderingContext.UNSIGNED_SHORT_5_5_5_1:
            case WebGLRenderingContext.UNSIGNED_SHORT_5_6_5:
                levelData = new Uint16Array(buffer, 0, buffer.byteLength / 2);
                break;
            default:
                levelData = new Uint8Array(buffer);
                break;
            }

            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                webglFormat.format,
                width,
                height,
                0,
                webglFormat.format,
                webglFormat.type,
                levelData
            );
        }

        return texture;
    }
}

export class ModelSplitterBasisLoader {
    private worker: Worker;
    private pendingTextures = new Map<number, PendingTextureRequest>();
    private nextPendingTextureId = 1;
    private canvas: HTMLCanvasElement;
    private gl: WebGLRenderingContext;
    private supportedFormats: SupportedFormats;
    private mutexLock = new Mutex();

    constructor(scriptPath: string, allowAlpha = true) {
        // create webgl2 canvas
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2', {
            alpha: allowAlpha,
            antialias: false,
            depth: false,
            desynchronized: true,
            preserveDrawingBuffer: true,
            stencil: false,
        });

        if (gl === null) {
            throw new Error('Failed to get webgl2 context. Cannot load KTX2 image');
        }

        // setup shaders
        const vertShader = loadShader(gl, gl.VERTEX_SHADER, VERT_SHADER_SRC);
        const fragShader = loadShader(gl, gl.FRAGMENT_SHADER, FRAG_SHADER_SRC);

        const shaderProgram = gl.createProgram();
        if (shaderProgram === null) {
            throw new Error('Failed to create shader program');
        }

        gl.attachShader(shaderProgram, vertShader);
        gl.attachShader(shaderProgram, fragShader);
        gl.linkProgram(shaderProgram);

        if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
            throw new Error(`Failed to link shader program: ${gl.getProgramInfoLog(shaderProgram)}`);
        }

        // create VBO
        const vbo = gl.createBuffer();
        if (vbo === null) {
            throw new Error('Failed to create VBO');
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, TRI_DATA, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.useProgram(shaderProgram);
        const samplerLoc = gl.getUniformLocation(shaderProgram, 'sampler');
        gl.uniform1i(samplerLoc, 0);

        // check supported texture formats
        this.supportedFormats = {
            s3tc: !!gl.getExtension('WEBGL_compressed_texture_s3tc'),
            etc1: !!gl.getExtension('WEBGL_compressed_texture_etc1'),
            etc2: !!gl.getExtension('WEBGL_compressed_texture_etc'),
            pvrtc: !!gl.getExtension('WEBGL_compressed_texture_pvrtc'),
            astc: !!gl.getExtension('WEBGL_compressed_texture_astc'),
            bptc: !!gl.getExtension('EXT_texture_compression_bptc')
        }

        // Reload the current script as a worker
        this.worker = new Worker(scriptPath);
        this.worker.onmessage = (msg) => {
            // Find the pending texture associated with the data we just received
            // from the worker.
            const pendingTexture = this.pendingTextures.get(msg.data.id);
            if (!pendingTexture) {
                if (msg.data.error) {
                    console.error(`Basis transcode failed: ${msg.data.error}`);
                }
                console.error(`Invalid pending texture ID: ${msg.data.id}`);
                return;
            }

            // Remove the pending texture from the waiting list.
            this.pendingTextures.delete(msg.data.id);

            // make sure callbacks are OK
            if (!pendingTexture.resolve) {
                console.error(`PendingTextureRequest had an undefined resolve callback`);
                return;
            }

            if (!pendingTexture.reject) {
                console.error(`PendingTextureRequest had an undefined reject callback`);
                return;
            }

            // If the worker indicated an error has occured handle it now.
            if (msg.data.error) {
                console.error(`Basis transcode failed: ${msg.data.error}`);
                pendingTexture.reject(new Error(`${msg.data.error}`));
                return;
            }

            // Upload the image data returned by the worker.
            try {
                pendingTexture.texture = pendingTexture.uploadImageData(
                    msg.data.webglFormat,
                    msg.data.buffer,
                    msg.data.width,
                    msg.data.height,
                );
            } catch (err) {
                pendingTexture.reject(err);
                return;
            }

            pendingTexture.resolve({
                width: msg.data.width,
                height: msg.data.height,
                texture: pendingTexture.texture
            });
        };

        // store everything else (webgl related)
        this.canvas = canvas;
        this.gl = gl;
    }

    async loadFromUrl(urlFilename: string, urlRoot: string | undefined): Promise<HTMLCanvasElement> {
        // parse url
        const url = (new URL(urlFilename, urlRoot)).href;

        // acquire lock
        await this.mutexLock.acquire();

        try {
            // load texture
            const pendingTexture = new PendingTextureRequest(this.gl, url);
            this.pendingTextures.set(this.nextPendingTextureId, pendingTexture);

            this.worker.postMessage({
                id: this.nextPendingTextureId,
                url: url,
                supportedFormats: this.supportedFormats
            });

            this.nextPendingTextureId++;
            const result = await pendingTexture.promise;

            // paint to canvas
            this.canvas.width = result.width;
            this.canvas.height = result.height;
            this.gl.viewport(0, 0, result.width, result.height);
            this.gl.clearColor(0, 0, 0, 0);
            this.gl.clear(this.gl.COLOR_BUFFER_BIT);
            this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);

            return this.canvas;
        } catch(err) {
            this.done();
            throw err;
        }
    }

    done() {
        // release lock
        this.mutexLock.release();
    }
}
