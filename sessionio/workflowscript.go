package sessionio

import (
	"bytes"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// workflowMeta is what a Workflow run's script says about the run before the
// run has done anything: the `export const meta = {...}` literal every script
// opens with. Claude Code writes the script to
// workflows/scripts/<name>-wf_<runId>.js when it launches the run, and the run
// file only when the run is over, so mid-run the script is the one place the
// run's name, its description and all of its phases are written down, the
// phases not yet started included. Checked on this box: on all 78 runs that
// have both, name is the run file's workflowName, description its summary,
// and phases its phases, titles and details alike.
type workflowMeta struct {
	Name        string
	Description string
	Phases      []WorkflowPhase
}

// The parser's bounds. The literal has to close within maxMetaBytes of the
// start of the file (the longest of the 138 scripts on this box is 921 bytes;
// a script itself can reach 512 KB), and may nest maxMetaDepth deep below its
// top (the ones here nest two). Past either, the script has no meta.
const (
	maxMetaBytes = 64 << 10
	maxMetaDepth = 16
)

// parseWorkflowScript reads the meta literal at the head of a Workflow script.
// The literal is JavaScript rather than JSON: unquoted keys, single quotes,
// trailing commas, comments. The Workflow tool asks for a pure literal, with no
// variables, calls or interpolation, and that is the language read here:
// objects, lists, strings, numbers, true, false and null. Anything else, a
// script caught mid-write included, is ok=false, never a guess. A field of the
// wrong type costs only itself, as in a run file.
func parseWorkflowScript(b []byte) (workflowMeta, bool) {
	p := metaParser{src: b[:min(len(b), maxMetaBytes)]}
	p.space()
	for _, w := range []string{"export", "const", "meta"} {
		if !p.word(w) {
			return workflowMeta{}, false
		}
		p.space()
	}
	if !p.eat('=') {
		return workflowMeta{}, false
	}
	p.space()
	v, ok := p.value(0)
	if !ok || v.kind != metaObject {
		return workflowMeta{}, false
	}
	m := workflowMeta{Name: v.field("name").text(), Description: v.field("description").text()}
	if phases := v.field("phases"); phases.kind == metaList {
		for i, ph := range phases.items {
			m.Phases = append(m.Phases, WorkflowPhase{Index: i + 1, Title: ph.field("title").text(), Detail: ph.field("detail").text()})
		}
	}
	return m, true
}

// WorkflowScriptRun is the run a Workflow script belongs to, read off its file
// name: <name>-wf_<runId>.js, where the name is the workflow's own and may
// hold hyphens, or even "wf_", of its own.
func WorkflowScriptRun(name string) (string, bool) {
	base, ok := strings.CutSuffix(name, ".js")
	i := strings.LastIndex(base, "wf_")
	if !ok || i < 0 || (i > 0 && base[i-1] != '-') || len(base)-i <= len("wf_") {
		return "", false
	}
	return base[i:], true
}

type metaKind int

const (
	metaOther  metaKind = iota // a number, true, false or null: read past, never used
	metaString                 // str
	metaObject                 // fields
	metaList                   // items
)

// metaValue is one value of the literal.
type metaValue struct {
	kind   metaKind
	str    string
	fields map[string]metaValue
	items  []metaValue
}

// field is the value under k, the zero value when this is not an object or
// has no such key.
func (v metaValue) field(k string) metaValue { return v.fields[k] }

// text is the string this is, "" when it is not one.
func (v metaValue) text() string { return v.str }

// metaParser reads the literal one value at a time. Every method leaves pos
// just past what it read, and fails rather than skipping anything it does not
// know.
type metaParser struct {
	src []byte
	pos int
}

func (p *metaParser) peek() byte {
	if p.pos < len(p.src) {
		return p.src[p.pos]
	}
	return 0
}

func (p *metaParser) eat(c byte) bool {
	if p.peek() != c {
		return false
	}
	p.pos++
	return true
}

// space skips whitespace, line breaks and comments. An unterminated block
// comment runs to the end, where the next read fails.
func (p *metaParser) space() {
	for p.pos < len(p.src) {
		rest := p.src[p.pos:]
		switch {
		case bytes.HasPrefix(rest, []byte("//")):
			if end := bytes.IndexAny(rest, "\r\n"); end >= 0 {
				p.pos += end
			} else {
				p.pos = len(p.src)
			}
		case bytes.HasPrefix(rest, []byte("/*")):
			end := bytes.Index(rest[2:], []byte("*/"))
			if end < 0 {
				p.pos = len(p.src)
				return
			}
			p.pos += 2 + end + 2
		default:
			r, n := utf8.DecodeRune(rest)
			if !isJSSpace(r) {
				return
			}
			p.pos += n
		}
	}
}

// isJSSpace is JavaScript's whitespace and line terminators, the byte order
// mark among them.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\ufeff', '\u2028', '\u2029':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// word reads the keyword w, which must not run on into another identifier.
func (p *metaParser) word(w string) bool {
	if !bytes.HasPrefix(p.src[p.pos:], []byte(w)) {
		return false
	}
	if r, _ := utf8.DecodeRune(p.src[p.pos+len(w):]); isIdentPart(r) {
		return false
	}
	p.pos += len(w)
	return true
}

func isIdentStart(r rune) bool { return r == '$' || r == '_' || unicode.IsLetter(r) }

func isIdentPart(r rune) bool {
	return isIdentStart(r) || unicode.IsDigit(r) || r == '\u200c' || r == '\u200d'
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func (p *metaParser) value(depth int) (metaValue, bool) {
	if depth > maxMetaDepth {
		return metaValue{}, false
	}
	switch c := p.peek(); {
	case c == '{':
		return p.object(depth)
	case c == '[':
		return p.list(depth)
	case c == '\'' || c == '"' || c == '`':
		s, ok := p.quoted()
		return metaValue{kind: metaString, str: s}, ok
	case p.word("true") || p.word("false") || p.word("null"):
		return metaValue{}, true
	default:
		return metaValue{}, p.number()
	}
}

func (p *metaParser) object(depth int) (metaValue, bool) {
	p.pos++ // {
	v := metaValue{kind: metaObject, fields: map[string]metaValue{}}
	for {
		p.space()
		if p.eat('}') {
			return v, true
		}
		k, ok := p.key()
		if !ok {
			return metaValue{}, false
		}
		p.space()
		if !p.eat(':') {
			return metaValue{}, false
		}
		p.space()
		field, ok := p.value(depth + 1)
		if !ok {
			return metaValue{}, false
		}
		v.fields[k] = field // a repeated key: the last one stands, as in JavaScript
		p.space()
		if !p.eat(',') {
			return v, p.eat('}')
		}
	}
}

func (p *metaParser) list(depth int) (metaValue, bool) {
	p.pos++ // [
	v := metaValue{kind: metaList}
	for {
		p.space()
		if p.eat(']') {
			return v, true
		}
		item, ok := p.value(depth + 1)
		if !ok {
			return metaValue{}, false
		}
		v.items = append(v.items, item)
		p.space()
		if !p.eat(',') {
			return v, p.eat(']')
		}
	}
}

// key is a property name: an identifier, a string or a number.
func (p *metaParser) key() (string, bool) {
	start := p.pos
	switch c := p.peek(); {
	case c == '\'' || c == '"':
		return p.quoted()
	case isDigit(c) || c == '.':
		ok := p.number()
		return string(p.src[start:p.pos]), ok
	}
	for p.pos < len(p.src) {
		r, n := utf8.DecodeRune(p.src[p.pos:])
		if p.pos == start && !isIdentStart(r) || p.pos > start && !isIdentPart(r) {
			break
		}
		p.pos += n
	}
	return string(p.src[start:p.pos]), p.pos > start
}

// number reads past a numeric literal, a sign in front included, without
// working out its value: nothing the meta is read for is a number.
func (p *metaParser) number() bool {
	if c := p.peek(); c == '-' || c == '+' {
		p.pos++
	}
	digits := func(ok func(byte) bool) int {
		start := p.pos
		for p.pos < len(p.src) && (ok(p.src[p.pos]) || p.src[p.pos] == '_') {
			p.pos++
		}
		return p.pos - start
	}
	if p.peek() == '0' && p.pos+1 < len(p.src) && strings.IndexByte("xXoObB", p.src[p.pos+1]) >= 0 {
		p.pos += 2
		isHex := func(c byte) bool { return isDigit(c) || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' }
		if digits(isHex) == 0 {
			return false
		}
	} else {
		whole := digits(isDigit)
		fraction := 0
		if p.eat('.') {
			fraction = digits(isDigit)
		}
		if whole == 0 && fraction == 0 {
			return false
		}
		if c := p.peek(); c == 'e' || c == 'E' {
			p.pos++
			if c := p.peek(); c == '+' || c == '-' {
				p.pos++
			}
			if digits(isDigit) == 0 {
				return false
			}
		}
	}
	p.eat('n') // a BigInt
	r, _ := utf8.DecodeRune(p.src[p.pos:])
	return !isIdentPart(r) // 1px is not a number
}

// quoted reads a string in single or double quotes, or a template literal
// with no interpolation in it.
func (p *metaParser) quoted() (string, bool) {
	quote := p.src[p.pos]
	p.pos++
	var sb strings.Builder
	for p.pos < len(p.src) {
		switch c := p.src[p.pos]; {
		case c == quote:
			p.pos++
			return sb.String(), true
		case c == '\\':
			if !p.escape(&sb) {
				return "", false
			}
		case quote == '`' && c == '$' && p.pos+1 < len(p.src) && p.src[p.pos+1] == '{':
			return "", false // an interpolation: not a pure literal
		case quote == '`' && c == '\r':
			// A template's line breaks read as \n, however the file wrote them.
			sb.WriteByte('\n')
			p.pos++
			p.eat('\n')
		case quote != '`' && (c == '\n' || c == '\r'):
			return "", false
		default:
			sb.WriteByte(c)
			p.pos++
		}
	}
	return "", false
}

// escape reads one backslash escape into sb. Octal escapes are refused: a
// module is strict code, where they are a syntax error.
func (p *metaParser) escape(sb *strings.Builder) bool {
	p.pos++ // the backslash
	if p.pos >= len(p.src) {
		return false
	}
	c := p.src[p.pos]
	p.pos++
	switch c {
	case 'n':
		sb.WriteByte('\n')
	case 't':
		sb.WriteByte('\t')
	case 'r':
		sb.WriteByte('\r')
	case 'b':
		sb.WriteByte('\b')
	case 'f':
		sb.WriteByte('\f')
	case 'v':
		sb.WriteByte('\v')
	case '0':
		if isDigit(p.peek()) {
			return false
		}
		sb.WriteByte(0)
	case '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return false
	case 'x':
		n, ok := p.hex(2)
		if !ok {
			return false
		}
		sb.WriteRune(rune(n))
	case 'u':
		r, ok := p.unicodeEscape()
		if !ok {
			return false
		}
		sb.WriteRune(r)
	case '\r': // a line continuation
		p.eat('\n')
	case '\n':
	default:
		// Anything else stands for itself: \' \" \\ \` and the rest. A line or
		// paragraph separator after the backslash continues the line.
		p.pos--
		r, n := utf8.DecodeRune(p.src[p.pos:])
		p.pos += n
		if r != '\u2028' && r != '\u2029' {
			sb.WriteRune(r)
		}
	}
	return true
}

// unicodeEscape reads what follows \u: four hex digits, or a code point in
// braces. A high surrogate followed by an escaped low one is one character.
func (p *metaParser) unicodeEscape() (rune, bool) {
	if p.eat('{') {
		end := bytes.IndexByte(p.src[p.pos:], '}')
		if end < 1 {
			return 0, false
		}
		n, err := strconv.ParseUint(string(p.src[p.pos:p.pos+end]), 16, 32)
		if err != nil || n > unicode.MaxRune {
			return 0, false
		}
		p.pos += end + 1
		return rune(n), true
	}
	hi, ok := p.hex(4)
	if !ok {
		return 0, false
	}
	if utf16.IsSurrogate(rune(hi)) && bytes.HasPrefix(p.src[p.pos:], []byte(`\u`)) {
		save := p.pos
		p.pos += 2
		if lo, ok := p.hex(4); ok {
			if r := utf16.DecodeRune(rune(hi), rune(lo)); r != unicode.ReplacementChar {
				return r, true
			}
		}
		p.pos = save
	}
	return rune(hi), true
}

// hex reads exactly n hex digits.
func (p *metaParser) hex(n int) (uint64, bool) {
	if p.pos+n > len(p.src) {
		return 0, false
	}
	v, err := strconv.ParseUint(string(p.src[p.pos:p.pos+n]), 16, 32)
	if err != nil {
		return 0, false
	}
	p.pos += n
	return v, true
}
