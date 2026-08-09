// Command archlint fails the build on a forbidden import (invariant I-12).
//
// Two boundaries in this repository cannot be held by review alone, because
// crossing either one produces code that compiles, passes its tests, and starts
// up normally:
//
//   - ADR-002 / §2.5.1. cmd/sos-ingest is a separate binary so that a bad
//     control-plane deploy cannot take SOS down with it. An import that reaches
//     into control-plane code rebuilds that coupling silently: the binary still
//     answers, and it now ships on the control plane's release cadence instead
//     of its own twice-a-year one.
//
//   - §2.5.3 / §7.3. The control-plane modules must stay individually
//     extractable. `vault` importing `journey` costs nothing today and is a
//     rewrite in 2029. Cross-module calls go through a consumer-defined
//     interface or a bus event.
//
// Rules live in rules.json next to this file so that relaxing one is a diff a
// reviewer can read, with the reason attached to it.
//
// Usage (from backend/): go run ./tools/archlint
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Rules is rules.json.
type Rules struct {
	Module string `json:"module"`
	Kernel Kernel `json:"kernel"`
	Rules  []Rule `json:"rules"`
}

// Kernel names the packages every layer above may depend on. Everything else
// under internal/ is a control-plane module, so a package added tomorrow is
// fenced by default rather than after somebody remembers to register it.
type Kernel struct {
	Packages []string `json:"packages"`
	Why      string   `json:"why"`
}

// Rule is one boundary. Kind is allow_only, deny or isolate.
type Rule struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"`
	Cite       string   `json:"cite"`
	Why        string   `json:"why"`
	From       string   `json:"from,omitempty"`
	To         string   `json:"to,omitempty"`
	Allow      []string `json:"allow,omitempty"`
	Set        string   `json:"set,omitempty"`
	AllowEdges []Edge   `json:"allow_edges,omitempty"`
}

// Edge is a named exception to an isolate rule. Each one carries the reason it
// is tolerable, because an exception list without reasons becomes a wishlist.
type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Why  string `json:"why"`
}

const (
	kindAllowOnly = "allow_only"
	kindDeny      = "deny"
	kindIsolate   = "isolate"
)

// imp is one import statement, kept with the position that reported it so the
// failure names a line a person can open.
type imp struct {
	path string
	pos  token.Position
}

// srcFile is a parsed .go file reduced to what the lint needs.
type srcFile struct {
	rel  string // slash path relative to the module root
	pkg  string // slash directory relative to the module root, e.g. "internal/store"
	imps []imp
}

type linter struct {
	root    string
	rules   Rules
	kernel  []string
	files   []srcFile
	pkgs    map[string]bool
	edges   int
	reports []report
}

type report struct {
	file string
	pos  token.Position
	from string
	to   string
	rule Rule
	note string
}

func main() {
	rulesPath := flag.String("rules", "", "path to rules.json (default: <module root>/tools/archlint/rules.json)")
	rootFlag := flag.String("root", "", "module root (default: nearest go.mod at or above the working directory)")
	flag.Parse()

	if err := run(*rootFlag, *rulesPath); err != nil {
		fmt.Fprintln(os.Stderr, "archlint: "+err.Error())
		os.Exit(1)
	}
}

func run(rootFlag, rulesPath string) error {
	root, modPath, err := findModule(rootFlag)
	if err != nil {
		return err
	}
	if rulesPath == "" {
		rulesPath = filepath.Join(root, "tools", "archlint", "rules.json")
	}
	raw, err := os.ReadFile(rulesPath)
	if err != nil {
		return fmt.Errorf("reading rules: %w", err)
	}
	var rules Rules
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rules); err != nil {
		return fmt.Errorf("%s: %w", rulesPath, err)
	}
	// A rules file copied from another module would lint nothing and report
	// success, which is worse than not running at all.
	if rules.Module != modPath {
		return fmt.Errorf("%s declares module %q but go.mod says %q", rulesPath, rules.Module, modPath)
	}

	l := &linter{root: root, rules: rules, pkgs: map[string]bool{}}
	l.kernel = append([]string(nil), rules.Kernel.Packages...)
	sort.Strings(l.kernel)

	if err := l.scan(modPath); err != nil {
		return err
	}
	if err := l.validate(); err != nil {
		return err
	}
	l.check(modPath)

	if len(l.reports) > 0 {
		l.print()
		return fmt.Errorf("%d forbidden import(s)", len(l.reports))
	}
	fmt.Printf("archlint: %d packages, %d internal edges, %d rules — clean\n",
		len(l.pkgs), l.edges, len(rules.Rules))
	return nil
}

// findModule walks up from start (or the working directory) to the nearest
// go.mod and returns its directory and module path.
func findModule(start string) (string, string, error) {
	dir := start
	if dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", "", err
		}
		dir = wd
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", "", err
	}
	for {
		b, err := os.ReadFile(filepath.Join(abs, "go.mod"))
		if err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimSpace(line)
				if rest, ok := strings.CutPrefix(line, "module"); ok {
					return abs, strings.TrimSpace(rest), nil
				}
			}
			return "", "", fmt.Errorf("%s has no module line", filepath.Join(abs, "go.mod"))
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			return "", "", fmt.Errorf("no go.mod at or above %s", dir)
		}
		abs = parent
	}
}

func (l *linter) scan(modPath string) error {
	fset := token.NewFileSet()
	return filepath.WalkDir(l.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if p == l.root {
				return nil
			}
			// _ and . prefixes are ignored by the go tool too; testdata holds
			// files that are deliberately not part of the build.
			if strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") ||
				name == "testdata" || name == "vendor" || name == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		f, perr := parser.ParseFile(fset, p, nil, parser.ImportsOnly)
		if perr != nil {
			return fmt.Errorf("parsing %s: %w", p, perr)
		}
		rel, rerr := filepath.Rel(l.root, p)
		if rerr != nil {
			return rerr
		}
		relSlash := filepath.ToSlash(rel)
		pkg := filepath.ToSlash(filepath.Dir(rel))
		if pkg == "." {
			pkg = ""
		}
		l.pkgs[pkg] = true

		sf := srcFile{rel: relSlash, pkg: pkg}
		for _, spec := range f.Imports {
			ip, uerr := strconv.Unquote(spec.Path.Value)
			if uerr != nil {
				return fmt.Errorf("%s: unreadable import %s", relSlash, spec.Path.Value)
			}
			if ip != modPath && !strings.HasPrefix(ip, modPath+"/") {
				continue // stdlib; the backend has no third-party imports by policy
			}
			sf.imps = append(sf.imps, imp{path: ip, pos: fset.Position(spec.Pos())})
		}
		l.files = append(l.files, sf)
		return nil
	})
}

// validate rejects a rules file that has drifted from the tree. A rule naming a
// package that was renamed is silently disarmed, which is the failure mode this
// whole tool exists to prevent.
func (l *linter) validate() error {
	for _, k := range l.rules.Kernel.Packages {
		if !l.pkgs[k] {
			return fmt.Errorf("rules.json: kernel package %q does not exist", k)
		}
	}
	for _, r := range l.rules.Rules {
		if r.ID == "" {
			return fmt.Errorf("rules.json: a rule has no id")
		}
		switch r.Kind {
		case kindAllowOnly:
			if r.From == "" || len(r.Allow) == 0 {
				return fmt.Errorf("rule %s: allow_only needs 'from' and a non-empty 'allow'", r.ID)
			}
			if !l.pkgs[r.From] {
				return fmt.Errorf("rule %s: 'from' package %q does not exist", r.ID, r.From)
			}
			for _, a := range r.Allow {
				if !l.pkgs[a] {
					return fmt.Errorf("rule %s: allows %q, which does not exist", r.ID, a)
				}
			}
		case kindDeny:
			if r.From == "" || r.To == "" {
				return fmt.Errorf("rule %s: deny needs 'from' and 'to'", r.ID)
			}
		case kindIsolate:
			if r.Set == "" {
				return fmt.Errorf("rule %s: isolate needs 'set'", r.ID)
			}
			for _, e := range r.AllowEdges {
				if e.Why == "" {
					return fmt.Errorf("rule %s: exception %s → %s has no reason", r.ID, e.From, e.To)
				}
				if !l.pkgs[e.From] || !l.pkgs[e.To] {
					return fmt.Errorf("rule %s: exception %s → %s names a package that does not exist",
						r.ID, e.From, e.To)
				}
			}
		default:
			return fmt.Errorf("rule %s: unknown kind %q", r.ID, r.Kind)
		}
	}
	return nil
}

// layerOf classifies a package. Kernel first: kernel packages live under
// internal/ and would otherwise read as control-plane modules.
func (l *linter) layerOf(pkg string) string {
	for _, k := range l.kernel {
		if pkg == k || strings.HasPrefix(pkg, k+"/") {
			return "kernel"
		}
	}
	switch {
	case strings.HasPrefix(pkg, "internal/"):
		return "module"
	case strings.HasPrefix(pkg, "cmd/"):
		return "cmd"
	case strings.HasPrefix(pkg, "tools/"):
		return "tool"
	}
	return "other"
}

// matches resolves a selector: "@layer", a "prefix/**" glob, or an exact path.
func (l *linter) matches(sel, pkg string) bool {
	if after, ok := strings.CutPrefix(sel, "@"); ok {
		return l.layerOf(pkg) == after
	}
	if before, ok := strings.CutSuffix(sel, "/**"); ok {
		return pkg == before || strings.HasPrefix(pkg, before+"/")
	}
	return pkg == sel
}

func (l *linter) check(modPath string) {
	for _, f := range l.files {
		for _, i := range f.imps {
			to := strings.TrimPrefix(strings.TrimPrefix(i.path, modPath), "/")
			if to == f.pkg {
				continue
			}
			l.edges++
			for _, r := range l.rules.Rules {
				if note, bad := l.breaks(r, f.pkg, to); bad {
					l.reports = append(l.reports, report{
						file: f.rel, pos: i.pos, from: f.pkg, to: to, rule: r, note: note,
					})
				}
			}
		}
	}
}

func (l *linter) breaks(r Rule, from, to string) (string, bool) {
	switch r.Kind {
	case kindAllowOnly:
		if !l.matches(r.From, from) {
			return "", false
		}
		for _, a := range r.Allow {
			if to == a || strings.HasPrefix(to, a+"/") {
				return "", false
			}
		}
		return "permitted imports are " + strings.Join(r.Allow, ", "), true

	case kindDeny:
		if l.matches(r.From, from) && l.matches(r.To, to) {
			return r.From + " may not import " + r.To, true
		}

	case kindIsolate:
		if !l.matches(r.Set, from) || !l.matches(r.Set, to) {
			return "", false
		}
		for _, e := range r.AllowEdges {
			if e.From == from && e.To == to {
				return "", false
			}
		}
		return "both are in " + r.Set + "; the call goes through a consumer-defined interface or a bus event", true
	}
	return "", false
}

func (l *linter) print() {
	sort.Slice(l.reports, func(i, j int) bool {
		if l.reports[i].file != l.reports[j].file {
			return l.reports[i].file < l.reports[j].file
		}
		return l.reports[i].pos.Line < l.reports[j].pos.Line
	})
	for _, v := range l.reports {
		fmt.Fprintf(os.Stderr, "\nFAIL %s:%d:%d\n", v.file, v.pos.Line, v.pos.Column)
		fmt.Fprintf(os.Stderr, "     import  %s\n", v.to)
		fmt.Fprintf(os.Stderr, "     edge    %s → %s\n", v.from, v.to)
		fmt.Fprintf(os.Stderr, "     rule    %s (%s)\n", v.rule.ID, v.rule.Cite)
		fmt.Fprintf(os.Stderr, "     %s\n", v.note)
		fmt.Fprintf(os.Stderr, "     why     %s\n", v.rule.Why)
	}
	fmt.Fprintln(os.Stderr)
}
