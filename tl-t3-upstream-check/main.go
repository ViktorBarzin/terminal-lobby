// tl-t3-upstream-check reports whether the box runs the latest stable T3
// Code release, for the T3StableHeld alert (ADR-0045).
//
// The T3 view follows upstream's stable releases: a daily CI job
// (.github/workflows/t3-stable.yml) rebuilds against a new release and, when
// the build and tests pass, lands the new pin. A release that fails stays
// unlanded, which is the hold. That job holds no alerting credential, so the
// box reports instead: once a day this writes the publish time of the newest
// stable release the installed package is not pinned to, and an alert fires
// when that has been waiting too long. A check that stops running is caught by
// the file's age.
//
//	tl-t3-upstream-check [-pin FILE] [-textfile FILE] [-url URL] [-timeout D]
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	var (
		pin = flag.String("pin", "/usr/lib/terminal-lobby/tl-t3-view/T3_PIN",
			"the T3_PIN the installed T3 view was built from")
		textfile = flag.String("textfile", "/var/lib/node_exporter/textfile/tl-t3-upstream.prom",
			"where node_exporter's textfile collector reads the metric")
		url = flag.String("url", "",
			"releases API URL for the latest release; empty derives it from the pin's repo=")
		timeout = flag.Duration("timeout", 30*time.Second, "how long the whole check may take")
	)
	flag.Parse()
	log.SetFlags(0) // journald stamps the lines

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	if err := run(ctx, &http.Client{}, *pin, *url, *textfile); err != nil {
		log.Printf("tl-t3-upstream-check: %v", err)
		os.Exit(1)
	}
}
