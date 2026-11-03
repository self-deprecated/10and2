{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs_24,
}:
buildNpmPackage {
  pname = "10and2";
  version = (lib.importJSON ./package.json).version;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [./src ./package.json ./package-lock.json];
  };
  nodejs = nodejs_24;
  npmDepsHash = "sha256-j3wYqagzJHxdslmxyw62vv1627xM5cpS+iKGCXHtMm8=";
  # The same single bundled file npm publishes (`npm run build`): no TypeScript or node_modules at runtime.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/10and2 $out/bin
    cp dist/10and2.js $out/lib/10and2/
    makeWrapper ${lib.getExe nodejs_24} $out/bin/10and2 \
      --add-flags --disable-warning=ExperimentalWarning \
      --add-flags $out/lib/10and2/10and2.js
    runHook postInstall
  '';
  meta = {
    description = "10and2: the connector for 10 & 2, the voice app for your coding agents";
    homepage = "https://10and2.app";
    mainProgram = "10and2";
    platforms = lib.platforms.linux ++ ["aarch64-darwin"];
  };
}
