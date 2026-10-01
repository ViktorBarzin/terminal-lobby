package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"testing"
)

// The fake host is this test binary re-run with TLB_FAKE_HOST set. It speaks
// just enough of the host's side of MCP to exercise the launcher, and appends
// one line per thing it sees to TLB_FAKE_LOG so a test can tell how many times
// it was started, what it was sent, and whether it was told to stop.
//
//	tools/call browser_close  reply, then exit 0, as the real host does
//	tools/call die            exit 1 without replying, a crash mid-call
//	tools/call hang           never reply
//	anything else             reply "ok <tool>"
//
// TLB_FAKE_REFUSE_CLOSE answers browser_close with an error and stays up, as
// the real host does while a person holds control.
// TLB_FAKE_IGNORE_TERM makes it shrug off SIGTERM and its stdin closing, for
// the SIGKILL fallback.

const fakeDescribe = `{"initialize":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fake-host","version":"1"},"instructions":"close the browser when done"},"tools":{"tools":[{"name":"browser_navigate","inputSchema":{"type":"object"}},{"name":"browser_close","inputSchema":{"type":"object"}}]}}`

func TestMain(m *testing.M) {
	if os.Getenv("TLB_FAKE_HOST") != "" {
		runFakeHost()
		return
	}
	os.Exit(m.Run())
}

func fakeLog(format string, args ...any) {
	path := os.Getenv("TLB_FAKE_LOG")
	if path == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, format+"\n", args...)
}

func runFakeHost() {
	if len(os.Args) > 1 && os.Args[len(os.Args)-1] == "--describe" {
		fakeLog("describe")
		fmt.Println(fakeDescribe)
		os.Exit(0)
	}
	fakeLog("spawn %d", os.Getpid())

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM)
	go func() {
		for range sigs {
			fakeLog("term")
			if os.Getenv("TLB_FAKE_IGNORE_TERM") == "" {
				os.Exit(0)
			}
		}
	}()

	out := bufio.NewWriter(os.Stdout)
	reply := func(id json.RawMessage, result string) {
		fmt.Fprintf(out, `{"jsonrpc":"2.0","id":%s,"result":%s}`+"\n", id, result)
		out.Flush()
	}

	in := bufio.NewReader(os.Stdin)
	for {
		line, err := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" {
			fakeLog("recv %s", line)
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params struct {
					Name string `json:"name"`
				} `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &msg)
			switch {
			case msg.Method == "initialize":
				reply(msg.ID, `{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fake-host","version":"1"}}`)
			case msg.Method == "tools/call" && msg.Params.Name == "browser_close" && os.Getenv("TLB_FAKE_REFUSE_CLOSE") != "":
				reply(msg.ID, `{"content":[{"type":"text","text":"The user has taken control of the browser."}],"isError":true}`)
			case msg.Method == "tools/call" && msg.Params.Name == "browser_close":
				reply(msg.ID, `{"content":[{"type":"text","text":"closed"}]}`)
				fakeLog("exit")
				os.Exit(0)
			case msg.Method == "tools/call" && msg.Params.Name == "die":
				fakeLog("exit")
				os.Exit(1)
			case msg.Method == "tools/call" && msg.Params.Name == "hang":
			case msg.Method != "" && len(msg.ID) > 0:
				reply(msg.ID, fmt.Sprintf(`{"content":[{"type":"text","text":"ok %s"}]}`, msg.Params.Name))
			}
		}
		if err != nil {
			fakeLog("stdin closed")
			if os.Getenv("TLB_FAKE_IGNORE_TERM") != "" {
				select {}
			}
			os.Exit(0)
		}
	}
}
