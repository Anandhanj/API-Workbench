// electron-vite resolves `?asset` imports to the file's runtime path (copied into
// the build output and valid in both dev and the packaged app).
declare module '*?asset' {
  const assetPath: string;
  export default assetPath;
}
