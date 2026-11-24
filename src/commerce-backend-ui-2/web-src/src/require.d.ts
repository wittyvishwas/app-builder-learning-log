// The bundler (and jest) provide CommonJS require; the web tsconfig loads no Node types.
// Declared here, not in utils.ts: a module-level `declare const require` made Parcel treat `require` as a
// local binding, so it left require("./config.json") unbundled and the page failed in the admin with
// "Cannot find module './config.json'".
declare function require(id: string): Record<string, string>;
