{
  perSystem = {pkgs, ...}: {
    devShells.default = pkgs.mkShell {
      buildInputs = with pkgs; [
        # Go toolchain. nixpkgs builds gopls and golangci-lint with
        # go_1_27, so they parse what the compiler accepts.
        go_1_27
        gopls
        golangci-lint

        air # Backend hot reload behind `just dev`
        just # Task runner
        nodejs # web/ toolchain (vite 8)

        delve # Go debugger
        git
        gh
      ];

      shellHook = ''
        export CGO_ENABLED=0
      '';
    };

    formatter = pkgs.alejandra;
  };
}
