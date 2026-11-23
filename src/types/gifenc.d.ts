declare module 'gifenc' {
  export type PaletteColor = [number, number, number] | [number, number, number, number];

  export interface QuantizeOptions {
    format?: 'rgb565' | 'rgb444' | 'rgba4444';
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaColor?: number;
    clearAlphaThreshold?: number;
  }

  export interface GifStream {
    readonly buffer: ArrayBuffer;
    reset(): void;
    bytesView(): Uint8Array<ArrayBuffer>;
    bytes(): Uint8Array<ArrayBuffer>;
    writeByte(byte: number): void;
    writeBytes(data: ArrayLike<number>, offset?: number, byteLength?: number): void;
    writeBytesView(data: Uint8Array, offset?: number, byteLength?: number): void;
  }

  export interface WriteFrameOptions {
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    palette?: PaletteColor[] | null;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GifEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
    bytesView(): Uint8Array<ArrayBuffer>;
    readonly buffer: ArrayBuffer;
    readonly stream: GifStream;
    writeHeader(): void;
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
  }

  export function GIFEncoder(opts?: { initialCapacity?: number; auto?: boolean }): GifEncoderInstance;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: QuantizeOptions,
  ): PaletteColor[];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: PaletteColor[],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
