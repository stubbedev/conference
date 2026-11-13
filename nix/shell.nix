{
  perSystem = {
    inputs',
    pkgs,
    ...
  }: {
    devShells.default = pkgs.mkShell {
      buildInputs = with pkgs; [
        inputs'.devtools.packages.go
        gopls
        golangci-lint

        air # Backend hot reload behind `just dev`
        just # Task runner
        nodejs # web/ toolchain (vite 8)
        inkscape # `just icons` renders web/brand into web/public

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
