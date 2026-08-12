// Package configdiscovery loads a program's configuration from ./.config/<packageName>/,
// walking up from the working directory, with a fallback to ~/.config/<packageName>/, layered so
// project-local values win.
//
// Behavior is defined by packages/spec/SPEC.md, the contract five language implementations
// share. No third-party type appears in this package's exported surface; the libraries it wraps
// are an implementation detail, documented in loaders.go and unmarshal.go.
package configdiscovery

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Loaded is what Load returns - SPEC section 7.
type Loaded struct {
	Config map[string]any `json:"config"`
	// Found is true when at least one recognized *file* contributed. Defaults and environment
	// variables do not set it.
	Found bool `json:"found"`
	// Sources is application order, lowest effective priority first. Never nil.
	Sources []Source `json:"sources"`
}

var nonAlphanumeric = regexp.MustCompile(`[^A-Z0-9]`)

// Load reads packageName's configuration.
//
// Finding nothing is not an error: the result is the defaults with Found false and an empty
// Sources. Finding something broken is an error - a *ConfigError naming the path - because
// silently falling back to defaults when a YAML file has a tab in it is how a typo becomes an
// incident.
func Load(packageName string, opts ...Option) (*Loaded, error) {
	if packageName == "" || strings.ContainsAny(packageName, `/\`) ||
		packageName == "." || packageName == ".." {
		// A programming error, not a configuration one: it has no SPEC section 5 kind, and
		// dressing it up as a ConfigError would put it in the same branch as a broken file.
		return nil, fmt.Errorf("config discovery: package name %q must be a single path segment", packageName)
	}

	c := &config{strategy: "layered", arrayMerge: "replace"}
	for _, apply := range opts {
		apply(c)
	}
	if err := resolveAmbient(c, packageName); err != nil {
		return nil, err
	}

	userRoot := resolveUserRoot(packageName, c.home, c.env, c.warn)
	projectRoots, err := resolveProjectRoots(c.cwd, packageName, walkOptions{home: c.home, stopDir: c.stopDir})
	if err != nil {
		return nil, err
	}

	type block struct {
		root       string
		precedence int
	}
	blocks := make([]block, 0, len(projectRoots)+1)
	if userRoot != "" {
		blocks = append(blocks, block{userRoot, 1})
	}
	for _, root := range projectRoots {
		blocks = append(blocks, block{root, 2})
	}

	layers := make([]Layer, 0, len(blocks)+3)
	if len(c.defaults) > 0 {
		layers = append(layers, Layer{
			Value:  c.defaults,
			Source: Source{Path: "<defaults>", Format: "defaults", Precedence: 0},
		})
	}

	for _, b := range blocks {
		files, err := listConfigFiles(b.root, c.profile)
		if err != nil {
			return nil, err
		}
		for _, ref := range files {
			value, err := loadOne(ref, c.envPrefix)
			if err != nil {
				return nil, err
			}
			precedence := b.precedence
			if ref.format == "dotenv" {
				// SPEC section 3.1: a .env is its own layer, applied inside its root's block.
				precedence = 3
			}
			layers = append(layers, Layer{
				Value:  value,
				Root:   b.root,
				Source: Source{Path: ref.path, Format: ref.format, Precedence: precedence},
			})
		}
	}

	if fromEnv := envLayer(c.env, c.envPrefix, c.warn); len(fromEnv) > 0 {
		layers = append(layers, Layer{
			Value:  fromEnv,
			Source: Source{Path: "<env>", Format: "env", Precedence: 4},
		})
	}
	if len(c.overrides) > 0 {
		layers = append(layers, Layer{
			Value:  c.overrides,
			Source: Source{Path: "<overrides>", Format: "overrides", Precedence: 5},
		})
	}

	contributing := applyStrategy(layers, c.strategy)
	found := false
	for _, layer := range contributing {
		if layer.Root != "" {
			found = true
			break
		}
	}

	return &Loaded{
		Config:  mergeLayers(contributing, mergeOptions{arrayMerge: c.arrayMerge, warn: c.warn}),
		Found:   found,
		Sources: buildSources(contributing, c.relativeTo),
	}, nil
}

// resolveAmbient fills in the values that come from the process when the caller did not supply
// them. Each ambient read happens exactly here, and exactly once.
func resolveAmbient(c *config, packageName string) error {
	if c.warn == nil {
		c.warn = func(message string) { fmt.Fprintln(os.Stderr, "warning:", message) }
	}
	if c.cwd == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return &ConfigError{Kind: KindUnreadable, Message: err.Error(), Err: err}
		}
		c.cwd = cwd
	}
	if c.home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			// Not fatal: a process with no home simply has no user-level root.
			c.warn("no home directory: the user-level root will not be searched")
		}
		c.home = home
	}
	if !c.envSet {
		c.env = environMap(os.Environ())
	}
	if c.env == nil {
		c.env = map[string]string{}
	}
	if c.envPrefix == "" {
		c.envPrefix = nonAlphanumeric.ReplaceAllString(strings.ToUpper(packageName), "_")
	}
	c.envPrefix = strings.ToUpper(c.envPrefix)
	if c.cwd != "" {
		c.cwd = filepath.Clean(c.cwd)
	}
	return nil
}

func environMap(environ []string) map[string]string {
	out := make(map[string]string, len(environ))
	for _, entry := range environ {
		if name, value, found := strings.Cut(entry, "="); found {
			out[name] = value
		}
	}
	return out
}
