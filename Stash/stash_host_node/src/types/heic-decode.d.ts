declare module 'heic-decode' {
  export interface HeicDecodeOptions {
    buffer: Buffer | Uint8Array;
  }

  export interface HeicDecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  export interface HeicDecode {
    (options: HeicDecodeOptions): Promise<HeicDecodedImage>;
    all(options: HeicDecodeOptions): Promise<unknown>;
  }

  const decode: HeicDecode;
  export default decode;
}
