package configdiscovery

// The sources output - SPEC section 7. The only thing standing between a user who expected
// "debug" and an afternoon of guessing which of six layers set "trace", so every source that was
// read is listed, winners and losers alike.

import (
	"path/filepath"
	"sort"
	"strings"
)

// Source is one contributing input. The JSON tags are SPEC section 7's field names.
type Source struct {
	// Path is absolute at runtime, rewritten by WithRelativeTo. For the layers that are not
	// files it is the literal <defaults>, <env> or <overrides>.
	Path string `json:"path"`
	// Format is one of toml, yaml, json, jsonc, ini, dotenv, env, defaults, overrides.
	Format string `json:"format"`
	// Precedence is the layer number from the SPEC section 3.1 table.
	Precedence int `json:"precedence"`
	// Keys are the top-level keys this source contributed, sorted. Never nil, so it marshals as
	// [] rather than null: an empty list and "no answer" are different things to a reader.
	Keys []string `json:"keys"`
}

// buildSources emits entries in **application order** - the order the layers were merged, lowest
// effective priority first (SPEC section 3.1).
//
// That is ascending precedence with one documented exception: a root's .env (precedence 3)
// belongs inside that root's block, so a user-level .env still loses to a project-local
// config.toml. Sorting this list by precedence would reorder it into something that does not
// describe what happened.
func buildSources(layers []Layer, relativeTo string) []Source {
	sources := make([]Source, 0, len(layers))
	for _, layer := range layers {
		keys := make([]string, 0, len(layer.Value))
		for key := range layer.Value {
			keys = append(keys, key)
		}
		sort.Strings(keys)

		sources = append(sources, Source{
			Path:       rewritePath(layer.Source.Path, relativeTo),
			Format:     layer.Source.Format,
			Precedence: layer.Source.Precedence,
			Keys:       keys,
		})
	}
	return sources
}

func rewritePath(path, relativeTo string) string {
	// <defaults>, <env> and <overrides> are labels, not paths, and are passed through.
	if relativeTo == "" || !filepath.IsAbs(path) {
		return path
	}
	relative, err := filepath.Rel(relativeTo, path)
	if err != nil || relative == "." || strings.HasPrefix(relative, "..") {
		// Outside the fixture root: stay absolute rather than emit a ../../ climb that no
		// expected.json could match.
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(relative)
}
