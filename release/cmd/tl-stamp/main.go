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
		term  = flag.String("term", "", "path to the terminal page (with placeholders)")
		diag  = flag.String("diag", "", "path to the shared diagnostics core")
		out   = flag.String("out", "", "directory to write the stamped surfaces into")
		build = flag.String("build", "", "provenance stamp: the commit being built")
	)
	flag.Parse()
	for name, v := range map[string]*string{"lobby": lobby, "term": term, "diag": diag, "out": out, "build": build} {
		if *v == "" {
			fmt.Fprintf(os.Stderr, "tl-stamp: -%s is required\n", name)
			os.Exit(2)
		}
	}

	// The terminal page's identity has to be known before the lobby is stamped
	// with it: the lobby carries it in a meta tag so a client can find the
	// terminal page without a request.
	termAsset, err := release.AssetID(*term, *diag)
	check(err)
	lobbyAsset, err := release.AssetID(*lobby, *diag)
	check(err)

	stamps := release.Stamps{Build: *build, Asset: lobbyAsset, TermAsset: termAsset}
	lobbyOut, err := release.Stamp(*lobby, *diag, stamps)
	check(err)
	termOut, err := release.Stamp(*term, *diag, release.Stamps{Build: *build, Asset: termAsset, TermAsset: termAsset})
	check(err)

	check(os.MkdirAll(*out, 0o755))
	check(os.WriteFile(filepath.Join(*out, "index.html"), lobbyOut, 0o644))
	check(os.WriteFile(filepath.Join(*out, "term.html"), termOut, 0o644))

	// The two stamp endpoints the self-update healer reads.
	check(os.WriteFile(filepath.Join(*out, "build-id"), []byte(lobbyAsset), 0o644))
	check(os.WriteFile(filepath.Join(*out, "term-build-id"), []byte(termAsset), 0o644))

	report, err := json.MarshalIndent(map[string]string{
		"build": *build, "lobby_asset": lobbyAsset, "term_asset": termAsset,
	}, "", "  ")
	check(err)
	check(os.WriteFile(filepath.Join(*out, "stamps.json"), append(report, '\n'), 0o644))
	fmt.Printf("stamped: build=%s lobby=%s term=%s\n", *build, lobbyAsset, termAsset)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "tl-stamp:", err)
		os.Exit(1)
	}
}
