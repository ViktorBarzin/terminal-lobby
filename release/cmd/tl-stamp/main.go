// tl-stamp gives each servable surface its identity at build time.
//
// It replaces the stamping the deploy scripts did on the workstation. Doing it
// here is what lets the package be immutable: the identity a client compares is
// fixed when the artefact is built, not when someone installs it.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"terminal-lobby/release"
)

func main() {
	var (
		lobby = flag.String("lobby", "", "path to the built lobby page (with placeholders)")
		diag  = flag.String("diag", "", "path to the shared diagnostics core")
		out   = flag.String("out", "", "directory to write the stamped surface into")
		build = flag.String("build", "", "provenance stamp: the commit being built")
	)
	flag.Parse()
	for name, v := range map[string]*string{"lobby": lobby, "diag": diag, "out": out, "build": build} {
		if *v == "" {
			fmt.Fprintf(os.Stderr, "tl-stamp: -%s is required\n", name)
			os.Exit(2)
		}
	}

	// ONE SURFACE, ONE IDENTITY. There were two until 2026-09-05: the lobby, and
	// the terminal page it framed, which had a stamp of its own so it could
	// notice its own staleness on every reconnect. The lobby draws its own
	// terminal now, so there is one document, one asset id and one endpoint for
	// the healer to poll. A -term flag, a hashed copy of that page under
	// assets/, and a /term-build-id endpoint went with it.
	lobbyAsset, err := release.AssetID(*lobby, *diag)
	check(err)

	lobbyOut, err := release.Stamp(*lobby, *diag, release.Stamps{Build: *build, Asset: lobbyAsset})
	check(err)

	check(os.MkdirAll(*out, 0o755))
	check(os.WriteFile(filepath.Join(*out, "index.html"), lobbyOut, 0o644))

	// The stamp endpoint the self-update healer reads.
	check(os.WriteFile(filepath.Join(*out, "build-id"), []byte(lobbyAsset), 0o644))

	report, err := json.MarshalIndent(map[string]string{
		"build": *build, "lobby_asset": lobbyAsset,
	}, "", "  ")
	check(err)
	check(os.WriteFile(filepath.Join(*out, "stamps.json"), append(report, '\n'), 0o644))
	fmt.Printf("stamped: build=%s lobby=%s\n", *build, lobbyAsset)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "tl-stamp:", err)
		os.Exit(1)
	}
}
