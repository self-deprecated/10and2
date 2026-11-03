{
  description = "10and2: the connector for 10 & 2 (https://10and2.app)";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    # `nix run github:self-deprecated/10and2 -- setup`, or `nix profile install github:self-deprecated/10and2`.
    packages = forAll (pkgs: {
      default = pkgs.callPackage ./package.nix {};
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
