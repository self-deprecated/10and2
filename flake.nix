{
  description = "10and2: the connector for 10 & 2 (https://10and2.app)";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    # CVE-2026-111497 (CISA KEV, due 2026-11-10): out-of-bounds write in brotli's decoder, fixed in 1.2.1.
    # https://github.com/google/brotli/releases/tag/v1.2.1
    # nixpkgs: NixOS/nixpkgs#577208 (staging), #577244 (26.05 backport).
    # Node links the shared brotli, so swapping brotli 1.2.1 into the finished closure fixes it without rebuilding Node.
    # Linux only: rewriting store paths inside Mach-O binaries breaks their code signatures on aarch64-darwin.
    # Remove when the pinned nixpkgs ships brotli >= 1.2.1 (evaluation fails then, so it can't be forgotten).
    withFixedBrotli = pkgs: drv: let
      fixed = pkgs.brotli.overrideAttrs {
        version = "1.2.1";
        src = pkgs.fetchFromGitHub {
          owner = "google";
          repo = "brotli";
          tag = "v1.2.1";
          hash = "sha256-llY72cYffDv0ugsH0p89xIPEbElV4L8u7U/Fe8hT3gI=";
        };
      };
    in
      assert nixpkgs.lib.assertMsg (nixpkgs.lib.versionOlder pkgs.brotli.version "1.2.1")
      "nixpkgs now ships brotli ${pkgs.brotli.version}: remove withFixedBrotli from flake.nix.";
        if pkgs.stdenv.hostPlatform.isLinux
        then
          pkgs.replaceDependencies {
            inherit drv;
            replacements = [
              {
                oldDependency = pkgs.brotli.lib;
                newDependency = fixed.lib;
              }
              {
                oldDependency = pkgs.brotli.out;
                newDependency = fixed.out;
              }
              {
                oldDependency = pkgs.brotli.dev;
                newDependency = fixed.dev;
              }
            ];
          }
        else drv;
  in {
    # `nix run github:self-deprecated/10and2 -- setup`, or `nix profile install github:self-deprecated/10and2`.
    packages = forAll (pkgs: {
      default = withFixedBrotli pkgs (pkgs.callPackage ./package.nix {});
      "10and2" = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    });
    apps = forAll (pkgs: {
      default = {
        type = "app";
        program = pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      };
    });
    devShells = forAll (pkgs: {default = pkgs.mkShell {packages = [pkgs.nodejs_24];};});
  };
}
