package sessionio

import "testing"

func TestParseNotice(t *testing.T) {
	for _, tc := range []struct {
		name, in string
		want     Notice
		ok       bool
	}{
		{"plain", "1790894512 probe two: deploy finished", Notice{1790894512, "probe two: deploy finished"}, true},
		{"json escapes decode", `1790894512 build \"auth\" failed \u2014 C:\\src`, Notice{1790894512, `build "auth" failed — C:\src`}, true},
		{"raw utf-8 passes through", "1790894512 café — ok", Notice{1790894512, "café — ok"}, true},
		{"escaped trailing semicolon", `1790894512 done\u003b`, Notice{1790894512, "done;"}, true},
		{"a cut escape falls back to the raw text", `1790894512 cut at \u20`, Notice{1790894512, `cut at \u20`}, true},
		{"control characters are dropped", `1790894512 line one\nline\ttwo`, Notice{1790894512, "line one line two"}, true},
		{"unset", "", Notice{}, false},
		{"no text", "1790894512 ", Notice{}, false},
		{"whitespace only text", `1790894512 \n `, Notice{}, false},
		{"no stamp", "hello there", Notice{}, false},
		{"zero stamp", "0 hello", Notice{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseNotice(tc.in)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("ParseNotice(%q) = %+v, %v; want %+v, %v", tc.in, got, ok, tc.want, tc.ok)
			}
		})
	}
}

// A cut through a multi-byte rune at the hook's 1000-byte cap must not reach a
// push payload as invalid UTF-8.
func TestParseNoticeRepairsACutRune(t *testing.T) {
	got, ok := ParseNotice("1790894512 ends mid-rune \xe2\x80")
	if !ok || got.Text != "ends mid-rune" {
		t.Fatalf("got %+v, %v", got, ok)
	}
}
