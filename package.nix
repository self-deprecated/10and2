{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs_24,
}: let
  # The brain's sources, bundled in for `10and2 brain`: beside connector/ in Driver's repository, inside the public one.
  brainDir =
    if builtins.pathExists ./brain/src
    then ./brain
    else ../brain;
  brain = lib.fileset.toSource {
    root = brainDir;
    fileset = lib.fileset.unions [(brainDir + "/src") (brainDir + "/web")];
  };
in
  buildNpmPackage {
    pname = "10and2";
    version = (lib.importJSON ./package.json).version;
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [./src ./extensions ./build.mjs ./package.json ./package-lock.json];
    };
    postUnpack = ''
      cp -r ${brain} $sourceRoot/brain
      chmod -R u+w $sourceRoot/brain
    '';
    nodejs = nodejs_24;
    npmDepsHash = "sha256-9pBt6UqR8mzgXjBEG4gwvVN0Rl+2xbNQtfIkEiFGN00=";
    # The same bundled files npm publishes (`npm run build`): no TypeScript or node_modules at runtime.
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/10and2 $out/bin
      cp -r dist extensions $out/lib/10and2/
      makeWrapper ${lib.getExe nodejs_24} $out/bin/10and2 \
        --add-flags --disable-warning=ExperimentalWarning \
        --add-flags $out/lib/10and2/dist/10and2.js
      runHook postInstall
    '';
    meta = {
      description = "10and2: the connector for 10 & 2, the voice app for your coding agents, and a brain of your own";
      homepage = "https://10and2.app";
      mainProgram = "10and2";
      platforms = lib.platforms.linux ++ ["aarch64-darwin"];
    };
  }
