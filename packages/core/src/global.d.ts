// tsconfig.base.json's "lib" is ES2022 only (no "dom"), so this package
// never gets tempted to reach for a browser-only global. TextEncoder and
// TextDecoder are the one exception: they're the WHATWG Encoding API, not
// DOM, and are available natively in both Node (since v11) and browsers
// with identical behavior. Declaring just the surface this package uses
// avoids pulling in all of "dom" for two classes.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}
