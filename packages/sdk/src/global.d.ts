// tsconfig.base.json's "lib" is ES2022 only (no "dom"), so this package
// never gets tempted to reach for a browser-only global. TextEncoder is the
// one exception: it's the WHATWG Encoding API, not DOM, and is available
// natively in both Node (since v11) and browsers with identical behavior.
// Declaring just the surface this package uses avoids pulling in all of
// "dom" for one class. (Matches packages/core/src/global.d.ts.)

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
